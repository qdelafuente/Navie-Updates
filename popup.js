const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STORAGE_API_KEY = "openrouterApiKey";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const syncBtn = document.getElementById("syncBtn");
const syncStatus = document.getElementById("syncStatus");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

let chatHistory = [];

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function getSyllabi() {
  const res = await sendMessage({ type: "GET_SYLLABI" });
  return res?.ok ? (res.syllabi || []) : [];
}

function setSyncStatus(text) {
  syncStatus.textContent = text;
}

syncBtn.addEventListener("click", async () => {
  setSyncStatus("Syncing...");
  syncBtn.disabled = true;
  try {
    const res = await sendMessage({ type: "SYNC_SYLLABI" });
    if (!res?.ok) {
      setSyncStatus("Error: " + (res?.error || "unknown"));
      return;
    }
    setSyncStatus(`Done (${res.count} courses). Ask for a syllabus in the chat.`);
  } finally {
    syncBtn.disabled = false;
  }
});

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

saveKeyBtn.addEventListener("click", async () => {
  const key = (apiKeyInput.value || "").trim();
  if (key) {
    await chrome.storage.local.set({ [STORAGE_API_KEY]: key });
    apiKeyInput.value = "";
    settingsPanel.classList.add("hidden");
  }
});

async function getApiKey() {
  const o = await chrome.storage.local.get(STORAGE_API_KEY);
  return o[STORAGE_API_KEY] || "";
}

function appendMessage(role, content, isError = false) {
  const div = document.createElement("div");
  div.className = "msg " + (isError ? "error" : role);
  if (role === "assistant" && !isError) {
    div.innerHTML = linkify(content);
  } else {
    div.textContent = content;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function buildSyllabiContext(syllabi) {
  const withUrl = (syllabi || []).filter((s) => s.syllabusUrl);
  if (withUrl.length === 0) return "No syllabi synced. The user must click Sync first.";
  return withUrl.map((s) => `${s.courseName} -> ${s.syllabusUrl}`).join("\n");
}

function buildSystemPrompt(syllabi) {
  const list = buildSyllabiContext(syllabi);
  return `You are a helpful assistant. The user has these Blackboard syllabi (course -> link):

${list}

When they ask for the link to a specific syllabus (e.g. "Physics", "syllabus for Accounting"), return that link and optionally the course name. Respond in English. For other questions, respond normally.`;
}

sendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  const text = (chatInput.value || "").trim();
  if (!text) return;

  const apiKey = await getApiKey();
  if (!apiKey) {
    appendMessage("assistant", "Set your OpenRouter API Key in the ⚙ button and try again.", true);
    chatInput.value = "";
    return;
  }

  chatInput.value = "";
  const welcome = chatMessages.querySelector(".welcome");
  if (welcome) welcome.remove();
  appendMessage("user", text);
  sendBtn.disabled = true;

  const loadingEl = document.createElement("div");
  loadingEl.className = "msg assistant loading";
  loadingEl.textContent = "…";
  chatMessages.appendChild(loadingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const syllabi = await getSyllabi();
    const systemPrompt = buildSystemPrompt(syllabi);

    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text }
    ];

    const res = await sendMessage({
      type: "OPENROUTER_CHAT",
      apiKey,
      body: { model: DEFAULT_MODEL, messages, max_tokens: 512 }
    });

    loadingEl.remove();

    if (res == null || res === undefined) {
      appendMessage("assistant", "No response received. Check that the extension is active and try again.", true);
      return;
    }
    if (!res.ok) {
      const errText = res?.errorText || "";
      appendMessage("assistant", "Error connecting to the AI: " + (res?.status || "") + " " + errText.slice(0, 200), true);
      return;
    }

    const content = (res?.content ?? "").trim() || "(Sin respuesta)";

    appendMessage("assistant", content);
    chatHistory.push({ role: "user", content: text });
    chatHistory.push({ role: "assistant", content });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  } catch (e) {
    loadingEl.remove();
    appendMessage("assistant", "Error: " + (e?.message || e), true);
  } finally {
    sendBtn.disabled = false;
  }
}

(async function init() {
  const key = await getApiKey();
  if (key) apiKeyInput.placeholder = "••••••••";
  const res = await sendMessage({ type: "GET_SYLLABI" });
  if (res?.ok && res.syllabiSyncedAt) {
    setSyncStatus("Última sync: " + new Date(res.syllabiSyncedAt).toLocaleString());
  } else {
    setSyncStatus("Click Sync and then ask for a syllabus.");
  }
  if (!chatMessages.querySelector(".msg")) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = "<p>Click <strong>Sync</strong> to load your syllabi.</p><p>Then ask in the chat for a course link, e.g. «give me the syllabus for Physics».</p>";
    chatMessages.appendChild(welcome);
  }
})();
