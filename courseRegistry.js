/**
 * Course Registry — Flujo en dos fases
 *
 * 1) Sync de cursos (solo IDs + datos mínimos)
 *    GET /learn/api/public/v1/users/me/courses → guardar courseId, id si viene, URLs.
 *    En este punto NO se asignan nombres.
 *
 * 2) Enriquecimiento de nombres
 *    Por cada curso: GET /learn/api/public/v1/courses/{courseId} → name, description, externalAccessUrl.
 *    Con límite de concurrencia (5 en paralelo) para evitar rate limits/timeouts.
 *    Resultado: courseIndexByCourseId[courseId] = { courseId, name, normalizedName, ... }
 *
 * El courseId usado es el que sirve para detalles y para endpoints internos (/learn/api/v1/courses/{courseId}/...).
 */

(function (global) {
  "use strict";

  const CONCURRENCY_LIMIT = 5;

  const STORAGE_KEYS = {
    coursesByCourseId: "courseRegistry_coursesByCourseId",
    courseIdByNormalizedName: "courseRegistry_courseIdByNormalizedName",
    coursesList: "courseRegistry_coursesList",
    syncedAt: "courseRegistry_syncedAt"
  };

  /**
   * @typedef {Object} CourseMeta
   * @property {string} learnCourseId - courseId para /learn/api/v1/courses/{learnCourseId}/...
   * @property {string} [id] - item.id de la lista (links/UI)
   * @property {string} name - Nombre (solo tras enriquecimiento)
   * @property {string} [description]
   * @property {string} [externalAccessUrl]
   */

  /**
   * Ejecuta tareas con límite de concurrencia.
   * @param {Array<() => Promise<T>>} taskFns - funciones que devuelven promesas
   * @param {number} limit
   * @returns {Promise<T[]>}
   */
  async function runWithConcurrency(taskFns, limit) {
    const results = [];
    let index = 0;

    async function runNext() {
      const i = index++;
      if (i >= taskFns.length) return;
      const fn = taskFns[i];
      const value = await fn();
      results[i] = value;
      await runNext();
    }

    const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => runNext());
    await Promise.all(workers);
    return results;
  }

  /**
   * Normaliza nombre para búsqueda: lowercase, trim, sin acentos, espacios colapsados, sin puntuación común.
   */
  function normalizeCourseName(str) {
    if (typeof str !== "string") return "";
    let s = str.trim().toLowerCase();
    s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    s = s.replace(/\s+/g, " ");
    s = s.replace(/[.,:;()[\]]/g, " ").replace(/\s+/g, " ").trim();
    return s;
  }

  /**
   * Variantes normalizadas (con y sin " (Section X)" etc.).
   */
  function normalizedNameVariants(name) {
    const norm = normalizeCourseName(name);
    if (!norm) return [];
    const out = [norm];
    const withoutParens = norm.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (withoutParens && withoutParens !== norm) out.push(withoutParens);
    return out;
  }

  /**
   * Paso 1 — Lista mínima desde GET users/me/courses.
   * Solo IDs y datos mínimos. NO se asigna nombre.
   */
  function buildMinimalCourseList(results) {
    /** @type {Array<{ courseId: string, id?: string, externalAccessUrl?: string }>} */
    const list = [];
    const items = Array.isArray(results) ? results : [];
    for (const raw of items) {
      const item = raw?.course ?? raw;
      const id = item?.id ?? raw?.id;
      const courseId = (item?.courseId ?? item?.courseid ?? raw?.courseId ?? raw?.courseid ?? id ?? "").trim();
      if (!courseId) continue;
      const externalAccessUrl = item?.externalAccessUrl ?? raw?.externalAccessUrl;
      list.push({ courseId, id, externalAccessUrl });
    }
    return list;
  }

  /**
   * Paso 2 — Enriquecer un curso: GET /learn/api/public/v1/courses/{courseId}.
   * Devuelve { courseId, name, normalizedName, description?, externalAccessUrl? }.
   */
  async function enrichOneCourse(courseId, baseUrl, xsrf, fetchJson) {
    try {
      const url = `${baseUrl.replace(/\/$/, "")}/learn/api/public/v1/courses/${encodeURIComponent(courseId)}`;
      const data = await fetchJson(url, xsrf);
      const c = data?.course ?? data;
      const name = (c?.name ?? c?.displayName ?? c?.title ?? "").trim() || "(sin nombre)";
      const description = c?.description ?? undefined;
      const externalAccessUrl = c?.externalAccessUrl ?? data?.externalAccessUrl ?? undefined;
      return {
        courseId,
        name,
        normalizedName: normalizeCourseName(name),
        description,
        externalAccessUrl
      };
    } catch (_) {
      return {
        courseId,
        name: "(sin nombre)",
        normalizedName: "sin nombre",
        description: undefined,
        externalAccessUrl: undefined
      };
    }
  }

  /**
   * Construye la tabla maestra y el índice por nombre a partir de los resultados enriquecidos.
   */
  function buildCourseIndexFromEnriched(enrichedList, minimalList) {
    /** @type {Record<string, CourseMeta>} */
    const coursesByCourseId = {};
    /** @type {Record<string, string>} */
    const courseIdByNormalizedName = {};
    /** @type {CourseMeta[]} */
    const coursesList = [];

    const minimalByCourseId = {};
    for (const m of minimalList) minimalByCourseId[m.courseId] = m;

    for (const e of enrichedList) {
      if (!e?.courseId) continue;
      const minimal = minimalByCourseId[e.courseId] || {};
      const meta = {
        learnCourseId: e.courseId,
        id: minimal.id,
        name: e.name,
        description: e.description,
        externalAccessUrl: e.externalAccessUrl ?? minimal.externalAccessUrl
      };
      coursesByCourseId[e.courseId] = meta;
      coursesList.push(meta);
      for (const variant of normalizedNameVariants(e.name)) {
        if (variant) courseIdByNormalizedName[variant] = e.courseId;
      }
    }

    return { coursesByCourseId, courseIdByNormalizedName, coursesList };
  }

  /**
   * Sync completo: 1) GET users/me/courses (solo IDs), 2) Enriquecer con GET .../courses/{courseId} (máx 5 en paralelo), 3) Persistir.
   */
  async function syncCourses(baseUrl, xsrf, deps) {
    const log = [];
    const fetchJson = deps?.fetchJson;
    const logFn = deps?.log ?? (() => {});

    if (typeof fetchJson !== "function") {
      log.push("syncCourses: fetchJson is required");
      return { ok: false, count: 0, sample: [], log, error: "fetchJson es requerido" };
    }

    const base = baseUrl.replace(/\/$/, "");
    const listUrl = `${base}/learn/api/public/v1/users/me/courses?limit=200&offset=0`;

    log.push("Step 1: Fetching course list (IDs only)...");

    let data;
    try {
      data = await fetchJson(listUrl, xsrf);
    } catch (e) {
      const err = e?.message ?? String(e);
      if (/401|403|cookie/i.test(err)) {
        log.push("Open Blackboard and make sure you are logged in.");
        return { ok: false, count: 0, sample: [], log, error: "Open Blackboard and make sure you are logged in." };
      }
      log.push("Error: " + err);
      return { ok: false, count: 0, sample: [], log, error: err };
    }

    const results = data?.results ?? [];
    if (results.length === 0) {
      log.push("No courses found.");
      return { ok: true, count: 0, sample: [], log };
    }

    const minimalList = buildMinimalCourseList(results);
    log.push("Courses fetched: " + minimalList.length + " (no names yet).");

    log.push("Step 2: Enriching names (max " + CONCURRENCY_LIMIT + " in parallel)...");

    const taskFns = minimalList.map((min) => () => enrichOneCourse(min.courseId, base, xsrf, fetchJson));
    let enrichedList;
    try {
      enrichedList = await runWithConcurrency(taskFns, CONCURRENCY_LIMIT);
    } catch (e) {
      const err = e?.message ?? String(e);
      log.push("Enrichment error: " + err);
      return { ok: false, count: minimalList.length, sample: [], log, error: err };
    }

    const { coursesByCourseId, courseIdByNormalizedName, coursesList } = buildCourseIndexFromEnriched(enrichedList, minimalList);
    log.push("Names enriched. Master table with " + coursesList.length + " courses.");

    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.coursesByCourseId]: coursesByCourseId,
          [STORAGE_KEYS.courseIdByNormalizedName]: courseIdByNormalizedName,
          [STORAGE_KEYS.coursesList]: coursesList,
          [STORAGE_KEYS.syncedAt]: Date.now()
        });
        log.push("Registry saved to chrome.storage.local.");
      }
    } catch (e) {
      const err = "Error al guardar: " + (e?.message ?? e);
      log.push(err);
      return { ok: false, count: coursesList.length, sample: [], log, error: err };
    }

    const sample = coursesList.slice(0, 5).map((m) => ({ learnCourseId: m.learnCourseId, name: m.name }));
    sample.forEach((s) => logFn("Curso: " + s.name + " → " + s.learnCourseId));
    return { ok: true, count: coursesList.length, sample, log };
  }

  // Cache for the matching index so we only rebuild when the course set changes.
  let _courseResolveCache = { version: "", index: null };

  function truncateCourseMentionTail(tail) {
    if (!tail || typeof tail !== "string") return "";
    const s = tail.trim();
    if (!s) return "";
    const parts = s.split(/\s+(?:like|what|whats|which|when|how|about|tell|me|is|are|the|and|or)\b/i);
    return (parts[0] || s).trim();
  }

  /** Prefer text after the last of/for/in/on/… so "idea of whats attendance in micro" still resolves to "micro". */
  function extractTailAfterLastPreposition(rawQuery) {
    if (typeof rawQuery !== "string" || !rawQuery.trim()) return "";
    const q = rawQuery.trim();
    const re = /\b(?:of|for|in|on|about|de|del)\s+/gi;
    let lastEnd = -1;
    let m;
    while ((m = re.exec(q)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < 0 || lastEnd >= q.length) return "";
    let tail = q.slice(lastEnd).replace(/[?.!]+$/g, "").trim();
    return truncateCourseMentionTail(tail);
  }

  /**
   * Resuelve un curso a partir del texto del usuario (exacto → alias index → fuzzy → sugerencias).
   */
  function resolveCourse(queryText, courseIdByNormalizedName, coursesByCourseId) {
    const rawQuery = (queryText || "").trim();

    // 1) Extraer mención de curso de patrones tipo "syllabus of X", "grades in X", etc.
    let mentionRaw = rawQuery;
    const tailLast = extractTailAfterLastPreposition(rawQuery);
    if (tailLast && tailLast.length >= 2) {
      mentionRaw = tailLast;
    } else {
      const prepMatch = rawQuery.match(/\b(?:of|for|in|on|about|de|del)\s+(.+)$/i);
      if (prepMatch && prepMatch[1]) {
        const tail = prepMatch[1].trim();
        if (tail.length >= 2) mentionRaw = tail;
      }
    }
    // Remove conversational tails so prompts like
    // "syllabus of cost, do you have it?" keep only "cost".
    mentionRaw = mentionRaw
      .replace(/[\s,;:-]+(?:do\s+you\s+have\s+it|can\s+you\s+check|please|pls|por\s+fa(?:vor)?|puedes\s+mirarlo|me\s+lo\s+puedes\s+dar)\s*\?*$/i, "")
      .replace(/[\s,;:-]+(?:i\s+mean|es\s+decir)\s+.*$/i, "")
      .trim();

    // Helpers locales de normalización (incluye eliminación de acentos).
    const stripDiacritics = (s) =>
      typeof s === "string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";

    const simpleNormalize = (s) => {
      if (typeof s !== "string") return "";
      return stripDiacritics(s)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[^\w\s]/g, "")
        .trim();
    };

    (function expandShortMentions() {
      const k = simpleNormalize(mentionRaw);
      const rq = simpleNormalize(rawQuery);
      if (k === "data" || k === "fda") {
        mentionRaw = "fundamentals of data analysis";
      } else if (k === "data analysis") {
        mentionRaw = "fundamentals of data analysis";
      } else if (k === "physics" && !/\blab\b/i.test(rq)) {
        mentionRaw = "physics for computer science";
      }
    })();

    const baseLog = "Resolving: '" + rawQuery + "' → mention: '" + mentionRaw + "'";

    const tokenize = (s) => {
      const norm = simpleNormalize(s);
      return norm ? norm.split(/\s+/).filter(Boolean) : [];
    };

    const STOPWORDS = new Set([
      "of",
      "for",
      "and",
      "the",
      "de",
      "del",
      "introduction",
      "intro",
      "fundamentals",
      "fund",
      "advanced",
      "to",
      "in",
      "on",
      "course"
    ]);

    const makeAcronym = (name) => {
      const tokens = tokenize(name).filter((t) => !STOPWORDS.has(t));
      if (!tokens.length) return "";
      return tokens.map((t) => t[0]).join("");
    };

    // Sinónimos/bilingüe genéricos.
    const SYNONYM_MAP = {
      finance: ["finanzas", "fin"],
      finanzas: ["finance", "fin"],
      statistics: ["statistic", "statitics", "stats", "estadistica", "estadistica"],
      estadistica: ["statistics", "stats"],
      strategy: ["strat", "estrategia"],
      estrategia: ["strategy", "strat"],
      management: ["mgmt", "gestion", "gestion"],
      gestion: ["management", "mgmt"],
      international: ["intl"],
      fundamentals: ["fund"],
      intro: ["introduction"],
      micro: ["microeconomics", "microecon"],
      microecon: ["microeconomics", "micro"],
      microeconomics: ["micro", "microecon"],
      data: ["fundamentals of data analysis", "fda"],
      fda: ["fundamentals of data analysis", "data"],
      physics: ["physics for computer science"]
    };

    const expandSynonyms = (tokens) => {
      const out = new Set(tokens);
      for (const t of tokens) {
        const syns = SYNONYM_MAP[t];
        if (syns && syns.length) {
          for (const s of syns) out.add(simpleNormalize(s));
        }
      }
      return Array.from(out);
    };

    // Edit distance simple para tolerar typos.
    const levenshtein = (a, b) => {
      const s = a || "";
      const t = b || "";
      const n = s.length;
      const m = t.length;
      if (!n) return m;
      if (!m) return n;
      const dp = new Array(m + 1);
      for (let j = 0; j <= m; j++) dp[j] = j;
      for (let i = 1; i <= n; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= m; j++) {
          const tmp = dp[j];
          if (s[i - 1] === t[j - 1]) {
            dp[j] = prev;
          } else {
            dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
          }
          prev = tmp;
        }
      }
      return dp[m];
    };

    const stringSimilarity = (a, b) => {
      const na = simpleNormalize(a);
      const nb = simpleNormalize(b);
      if (!na && !nb) return 1;
      if (!na || !nb) return 0;
      const maxLen = Math.max(na.length, nb.length);
      if (!maxLen) return 1;
      const dist = levenshtein(na, nb);
      return 1 - dist / maxLen;
    };

    const tokenSetSimilarity = (aTokens, bTokens) => {
      if (!aTokens.length && !bTokens.length) return 1;
      if (!aTokens.length || !bTokens.length) return 0;
      const sa = new Set(aTokens);
      const sb = new Set(bTokens);
      let inter = 0;
      for (const t of sa) if (sb.has(t)) inter++;
      const union = sa.size + sb.size - inter;
      return union === 0 ? 0 : inter / union;
    };

    const mentionTokens = tokenize(mentionRaw);
    const mentionTokensExpanded = expandSynonyms(mentionTokens);
    const mentionNorm = simpleNormalize(mentionRaw);

    if (!mentionNorm) {
      const namesEmpty = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
      return { suggestions: namesEmpty, log: baseLog + " (empty mention)" };
    }

    // Inputs muy cortos → no match agresivo.
    if (mentionNorm.length < 3 && mentionTokensExpanded.length < 2) {
      const namesShort = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
      return { suggestions: namesShort, log: baseLog + " (too short; not resolving aggressively)" };
    }

    // 2) Fast path: exact normalized name en el índice existente.
    const exactId = courseIdByNormalizedName[mentionNorm];
    if (exactId && coursesByCourseId[exactId]) {
      const metaExact = coursesByCourseId[exactId];
      return {
        learnCourseId: metaExact.learnCourseId,
        meta: metaExact,
        log: "Resolved '" + rawQuery + "' → " + metaExact.name + " (" + metaExact.learnCourseId + ") [exact]"
      };
    }

    const courseIds = Object.keys(coursesByCourseId || {});
    if (!courseIds.length) {
      const namesNone = Object.values(coursesByCourseId).slice(0, 5).map((c) => c.name);
      return { suggestions: namesNone, log: baseLog + "; no courses indexed." };
    }

    // 3) Construir / reutilizar índice local de aliases.
    const versionKey = courseIds.sort().join("|");
    let index = null;
    if (_courseResolveCache.version === versionKey && _courseResolveCache.index) {
      index = _courseResolveCache.index;
    } else {
      index = [];
      for (const courseId of courseIds) {
        const meta = coursesByCourseId[courseId];
        if (!meta) continue;
        const name = meta.name || "";
        const normName = simpleNormalize(name);
        const tokens = tokenize(name).filter((t) => !STOPWORDS.has(t));
        const acronym = makeAcronym(name);
        const code = meta.id ? String(meta.id) : "";

        /** @type {{ alias: string, type: string, weight: number }[]} */
        const aliases = [];
        if (normName) aliases.push({ alias: normName, type: "name", weight: 1.0 });
        if (code) aliases.push({ alias: simpleNormalize(code), type: "code", weight: 0.98 });
        if (acronym) aliases.push({ alias: simpleNormalize(acronym), type: "acronym", weight: 0.92 });
        if (tokens.length >= 1) {
          const one = simpleNormalize(tokens.slice(0, 1).join(" "));
          if (one && one !== normName) aliases.push({ alias: one, type: "trunc1", weight: 0.85 });
        }
        if (tokens.length >= 2) {
          const two = simpleNormalize(tokens.slice(0, 2).join(" "));
          if (two && two !== normName) aliases.push({ alias: two, type: "trunc2", weight: 0.87 });
        }
        if (tokens.length >= 3) {
          const three = simpleNormalize(tokens.slice(0, 3).join(" "));
          if (three && three !== normName) aliases.push({ alias: three, type: "trunc3", weight: 0.89 });
        }

        const synTokens = expandSynonyms(tokens);
        if (synTokens.length && synTokens.join(" ") !== normName) {
          aliases.push({ alias: simpleNormalize(synTokens.join(" ")), type: "bilingual", weight: 0.8 });
        }

        index.push({ courseId, meta, normName, tokens, acronym, aliases });
      }
      _courseResolveCache = { version: versionKey, index };
    }

    // 4) Calcular score por curso usando todas las aliases.
    /** @type {{ courseId: string, meta: any, score: number }[]} */
    const scored = [];
    const mentionTokensSig = mentionTokensExpanded.filter((t) => !STOPWORDS.has(t));

    for (const entry of index) {
      const { courseId, meta, normName, tokens, acronym, aliases } = entry;
      let bestAliasScore = 0;

      for (const a of aliases) {
        const alias = a.alias;
        const baseWeight = a.weight;
        let s = 0;

        if (alias === mentionNorm) {
          s = 1.0;
        } else {
          if (alias.startsWith(mentionNorm) || mentionNorm.startsWith(alias)) {
            const lenRatio =
              Math.min(alias.length, mentionNorm.length) / Math.max(alias.length, mentionNorm.length || 1);
            if (mentionNorm.length >= 4) s = Math.max(s, 0.75 + lenRatio * 0.2);
          }
          const globalSim = stringSimilarity(alias, mentionNorm);
          s = Math.max(s, globalSim);

          const aliasTokens = alias.split(" ").filter(Boolean);
          const aliasExpanded = expandSynonyms(aliasTokens).filter((t) => !STOPWORDS.has(t));
          const tokenSim = tokenSetSimilarity(mentionTokensSig, aliasExpanded);
          s = Math.max(s, tokenSim);

          if (a.type === "acronym" && acronym && simpleNormalize(mentionNorm) === simpleNormalize(acronym)) {
            s = Math.max(s, 0.95);
          }
        }

        const weighted = s * baseWeight;
        if (weighted > bestAliasScore) bestAliasScore = weighted;
      }

      scored.push({ courseId, meta, score: bestAliasScore });
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];

    const MIN_CONFIDENCE = 0.45;
    const MIN_MARGIN = 0.12;

    if (!best || best.score < MIN_CONFIDENCE) {
      const namesLow = scored.slice(0, 5).map((s) => s.meta.name);
      return {
        suggestions: namesLow,
        log:
          baseLog +
          `; no confident match (best=${best ? best.score.toFixed(2) : "none"}). Sugerencias: ` +
          namesLow.join(", ")
      };
    }

    if (second && best.score - second.score < MIN_MARGIN) {
      const tie = scored.filter((s) => Math.abs(s.score - best.score) < MIN_MARGIN).slice(0, 6);
      const rqNorm = simpleNormalize(rawQuery);
      const mnNorm = simpleNormalize(mentionRaw);
      if (
        tie.length >= 2 &&
        /\bphysics\b/i.test(mentionRaw + " " + rawQuery) &&
        !/\blab\b/i.test(rqNorm)
      ) {
        const nonLab = tie.find((s) => !/\bLAB\b/i.test(s.meta.name));
        if (nonLab) {
          return {
            learnCourseId: nonLab.meta.learnCourseId,
            meta: nonLab.meta,
            log:
              baseLog +
              " → " +
              nonLab.meta.name +
              " (" +
              nonLab.meta.learnCourseId +
              ") [score=" +
              nonLab.score.toFixed(2) +
              ", physics tie-break: prefer non-LAB]"
          };
        }
      }
      if (tie.length >= 2 && (mnNorm === "data" || mnNorm === "fda" || /\bdata\b/i.test(mnNorm))) {
        const fda = tie.find((s) => /fundamentals\s+of\s+data\s+analysis/i.test(s.meta.name));
        if (fda) {
          return {
            learnCourseId: fda.meta.learnCourseId,
            meta: fda.meta,
            log:
              baseLog +
              " → " +
              fda.meta.name +
              " (" +
              fda.meta.learnCourseId +
              ") [score=" +
              fda.score.toFixed(2) +
              ", data tie-break: FDA]"
          };
        }
      }
      const amb = tie.map((s) => s.meta.name);
      return {
        suggestions: amb,
        log:
          baseLog +
          `; ambiguous match (best=${best.meta.name} ${best.score.toFixed(2)}, second=${second.meta.name} ${second.score.toFixed(
            2
          )}). Sugerencias: ` +
          amb.join(", ")
      };
    }

    return {
      learnCourseId: best.meta.learnCourseId,
      meta: best.meta,
      log:
        baseLog +
        " → " +
        best.meta.name +
        " (" +
        best.meta.learnCourseId +
        ") [score=" +
        best.score.toFixed(2) +
        "]"
    };
  }

  function getCourseContextForAI(coursesList) {
    const list = Array.isArray(coursesList) ? coursesList : [];
    return list.map((c) => ({
      learnCourseId: c.learnCourseId,
      name: c.name,
      externalAccessUrl: c.externalAccessUrl
    }));
  }

  function getCourseByLearnCourseId(learnCourseId, coursesByCourseId) {
    if (!learnCourseId || !coursesByCourseId) return null;
    return coursesByCourseId[learnCourseId] ?? null;
  }

  global.CourseRegistry = {
    STORAGE_KEYS,
    CONCURRENCY_LIMIT,
    normalizeCourseName,
    normalizedNameVariants,
    buildMinimalCourseList,
    enrichOneCourse,
    runWithConcurrency,
    syncCourses,
    resolveCourse,
    getCourseContextForAI,
    getCourseByLearnCourseId
  };
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : this);
