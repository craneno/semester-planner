// quotes.js — the line at the top of the week.
//
// A planner that opens with "a busy week ahead" is a weather report. The point
// of the line is not to describe the load but to be worth reading on the
// morning you least want to start: the arena, the Moon speech, a Roman
// emperor telling himself to get out of bed. Struggle as the thing itself,
// not as the price of something else.
//
// Old enough to be out of copyright, or short enough and attributed. Anything
// merely *attributed* to someone on the internet stays out — a motto with the
// wrong name on it is worse than none.

import { diffDays } from './util.js';

export const QUOTES = [
  { text: 'Nothing in the world is worth having or worth doing unless it means effort, pain, difficulty.',
    who: 'Theodore Roosevelt' },
  { text: 'Far better it is to dare mighty things than to take rank with those poor spirits who neither enjoy much nor suffer much.',
    who: 'Theodore Roosevelt' },
  { text: 'The credit belongs to the man who is actually in the arena, whose face is marred by dust and sweat and blood.',
    who: 'Theodore Roosevelt' },
  { text: 'Far and away the best prize that life offers is the chance to work hard at work worth doing.',
    who: 'Theodore Roosevelt' },
  { text: 'We choose to go to the Moon in this decade and do the other things, not because they are easy, but because they are hard.',
    who: 'John F. Kennedy, 1962' },
  { text: 'That challenge is one we are willing to accept, one we are unwilling to postpone, and one we intend to win.',
    who: 'John F. Kennedy, 1962' },
  { text: 'Tough and competent.',
    who: 'Gene Kranz, Mission Control, 1970' },
  { text: 'In the morning, when you rise unwillingly, hold this thought ready: I am rising to the work of a human being.',
    who: 'Marcus Aurelius' },
  { text: 'The art of living is more like wrestling than dancing.',
    who: 'Marcus Aurelius' },
  { text: 'Be like the rock against which the waves break. It stands firm, and tames the fury of the water around it.',
    who: 'Marcus Aurelius' },
  { text: 'No longer talk at all about the kind of man a good man ought to be. Be one.',
    who: 'Marcus Aurelius' },
  { text: 'Difficulties are the things that show what men are.',
    who: 'Epictetus' },
  { text: 'It is not because things are difficult that we do not dare. It is because we do not dare that they are difficult.',
    who: 'Seneca' },
  { text: 'If there is no struggle, there is no progress.',
    who: 'Frederick Douglass, 1857' },
  { text: 'The bravest are those who have the clearest vision of what is before them, glory and danger alike, and go out to meet it.',
    who: 'Thucydides' },
  { text: 'He who has a why to live can bear almost any how.',
    who: 'Friedrich Nietzsche' },
  { text: 'A smooth sea never made a skilled sailor.',
    who: 'Old sailing proverb' },
  { text: 'The obstacle in the path becomes the path. Never forget: within every obstacle is an opportunity.',
    who: 'Marcus Aurelius' }
];

/** A Monday, so the week a date belongs to is the week it reads on. */
const EPOCH_MONDAY = '1970-01-05';

/**
 * One quote per week, the same one all week. Deliberately not random: a line
 * that changes on every re-render is wallpaper, and one you have sat with
 * since Monday is something you have read.
 */
export function quoteForWeek(date, pool = QUOTES) {
  if (!pool.length) return null;
  const weeks = Math.floor(diffDays(EPOCH_MONDAY, date) / 7);
  return pool[((weeks % pool.length) + pool.length) % pool.length];
}
