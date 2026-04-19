/**
 * @typedef {"Q1" | "Q2" | "ANNUAL" | "ORGANIZATION_COMMUNITY" | "OTHER"} CourseCategory
 */

/**
 * @typedef {Object} ClassifiedMembership
 * @property {string | null} membershipId
 * @property {string | null} userId
 * @property {string | null} courseId
 * @property {string} courseDisplayName
 * @property {string | null} termName
 * @property {string | null} serviceLevelType
 * @property {boolean} isOrganization
 * @property {CourseCategory} category
 * @property {string | null} externalAccessUrl
 * @property {boolean} isAvailable
 * @property {string | null} lastAccessDate
 * @property {any} [raw]
 */

/**
 * @typedef {Object} ClassificationTotals
 * @property {number} Q1
 * @property {number} Q2
 * @property {number} ANNUAL
 * @property {number} ORGANIZATION_COMMUNITY
 * @property {number} OTHER
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {ClassificationTotals} totals
 * @property {ClassifiedMembership[]} items
 */

