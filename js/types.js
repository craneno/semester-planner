// @ts-check
// types.js — the shapes, written down once. Nothing runs here.
//
// JSDoc only: the app stays plain JS, and the editor and `tsc` read these.
// A module says `// @ts-check` at its top to be checked; the rest are not,
// yet. `import('./types.js').Item` names a shape from anywhere.

/** A calendar day, 'YYYY-MM-DD', local. @typedef {string} Day */
/** A time of day, 'HH:MM', 24h. @typedef {string} Clock */
/** An ISO timestamp. @typedef {string} Stamp */

/**
 * When a task is planned. Scheduled: `start` and `mins`. All day: no
 * `start`; `end` makes it a stretch of days, and is only there when it is
 * after `date`.
 * @typedef {Object} Plan
 * @property {Day} date
 * @property {Clock|null} [start]
 * @property {number} [mins]
 * @property {Day} [end]
 */

/**
 * A repeat rule. `until` and `count` are alternatives; `ex` holds what one
 * occurrence owns, keyed by the day the rule gave it.
 * @typedef {Object} Repeat
 * @property {'daily'|'weekly'|'monthly'|'yearly'} freq
 * @property {number} every
 * @property {number[]} [days]
 * @property {Day|null} [until]
 * @property {number|null} [count]
 * @property {Object<string, Partial<Item> & { mode?: 'plan'|'due' }>} [ex]
 */

/**
 * A task: scheduled (`plan` with a start), all day (`plan` without), or a
 * deadline (`due`) — never two at once.
 * @typedef {Object} Item
 * @property {string} id
 * @property {string} title
 * @property {string|null} areaId
 * @property {'event'|'task'|'meeting'|'homework'} type
 * @property {Day|null} due
 * @property {Clock|null} dueTime
 * @property {Plan|null} plan
 * @property {'low'|'normal'|'high'} priority
 * @property {number} estMins
 * @property {boolean} done
 * @property {Stamp|null} doneAt
 * @property {{ id: string, text: string, done: boolean }[]} subtasks
 * @property {string} notes
 * @property {Repeat|null} repeat
 * @property {string|null} [color]     a colour of its own, else the area's
 * @property {string|null} canvasId
 * @property {string} [canvasCourse]
 * @property {string|null} [canvasArea]
 * @property {string} [icsUid]
 * @property {string|null} gcalId
 * @property {Object<string, string>|null} gcalIds
 * @property {Stamp} createdAt
 * @property {Stamp} updatedAt
 * @property {string} [seriesId]       on an occurrence: the rule it came from
 * @property {Day} [occurrence]        on an occurrence: the day the rule gave it
 */

/**
 * One meeting of a class, written in the zone it was written in.
 * @typedef {Object} Meeting
 * @property {number[]} days      0 Sunday … 6 Saturday
 * @property {Clock} start
 * @property {Clock} end
 * @property {string} [location]
 * @property {string} tz
 * @property {Object<string, null|{ start?: Clock, end?: Clock, location?: string }>} [ex]
 */

/**
 * A course, a project, or a personal area.
 * @typedef {Object} Area
 * @property {string} id
 * @property {string} name
 * @property {'course'|'project'|'personal'} category
 * @property {number} [order]
 * @property {string} [color]
 * @property {boolean} [archived]
 * @property {boolean} [onChart]
 * @property {boolean} [journal]
 * @property {string} [freewrite]
 * @property {Meeting[]} [schedule]
 * @property {Day} [from]
 * @property {Day} [until]
 * @property {Stamp} [createdAt]
 * @property {Stamp} [updatedAt]
 */

/**
 * A captured note, unfiled until given an area.
 * @typedef {Object} Card
 * @property {string} id
 * @property {string} text
 * @property {string|null} areaId
 * @property {Stamp} createdAt
 * @property {Stamp} updatedAt
 */

/**
 * @typedef {Object} Habit
 * @property {string} id
 * @property {string} name
 * @property {number} order
 * @property {boolean} archived
 * @property {Stamp} createdAt
 * @property {Stamp} [updatedAt]
 */

/**
 * A thing wanted, and the parcel it turns into.
 * @typedef {Object} Wish
 * @property {string} id
 * @property {string} title
 * @property {string|null} url
 * @property {number|null} price
 * @property {string} status         one of WISH_STATUSES
 * @property {Day|null} eta
 * @property {Object<string, any>|null} tracking
 * @property {Stamp} createdAt
 * @property {Stamp} updatedAt
 */

/**
 * A focus or a sprint: a stretch of the term in one area's lane.
 * @typedef {Object} Sprint
 * @property {string} id
 * @property {string|null} areaId
 * @property {'focus'|'sprint'} kind
 * @property {string} title
 * @property {Day} start
 * @property {Day} end
 * @property {{ id: string, text: string, done: boolean }[]} deliverables
 * @property {string} notes
 * @property {Stamp} createdAt
 * @property {Stamp} updatedAt
 */

/**
 * A saved link.
 * @typedef {Object} Link
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string|null} areaId
 * @property {Stamp} createdAt
 * @property {Stamp} updatedAt
 */

/** Settings: a bag, some keys synced (`SYNCED_SETTINGS`), the rest this device's. @typedef {Object<string, any>} Settings */

/**
 * The one live object.
 * @typedef {Object} State
 * @property {Item[]} items
 * @property {Area[]} areas
 * @property {Card[]} cards
 * @property {Object<string, any>} notes
 * @property {Link[]} links
 * @property {Wish[]} wishlist
 * @property {Sprint[]} sprints
 * @property {Habit[]} habits
 * @property {Object<string, string[]>} habitLog
 * @property {Object<string, Stamp>} habitLogAt
 * @property {any[]} events
 * @property {any[]} outbox
 * @property {{ name: string, start: Day, end: Day }} semester
 * @property {{ start: Day }} calendar
 * @property {Settings} settings
 */

export {};
