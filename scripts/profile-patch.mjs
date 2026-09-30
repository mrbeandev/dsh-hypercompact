/**
 * Clean stale preset rows out of a profile's own `cordis.patch.yml`.
 *
 * On DSH 0.1.7+ the preset is declared by a separate bundle. Two leftovers in
 * the profile's patch layer (which applies AFTER every bundle) can hide it:
 *
 *   1. a block between `# >>> dsh-hypercompact preset "<id>"` and
 *      `# <<< dsh-hypercompact preset "<id>"` markers, written by early
 *      versions of create-preset.mjs, holding an inline declaration;
 *   2. a top-level override `- id: preset-<id>` with `disabled: true`, which
 *      the plugin manager writes when the preset row is disabled.
 *
 * Only those rows are removed. Other rows that ended up between the markers
 * (the plugin manager appends new overrides at the end of the file) are kept.
 *
 * @module dsh-hypercompact/profile-patch
 */

/**
 * @param {string} text - the profile patch file.
 * @param {string} id - preset id (for example `hypercompact`).
 * @returns {{ text: string, removed: string[] }} the cleaned file and a description of each removal.
 */
export function cleanProfilePatch(text, id) {
  const lines = text.split('\n');
  const removed = [];
  const begin = lines.findIndex((line) => line.startsWith(`# >>> dsh-hypercompact preset "${id}"`));
  if (begin !== -1) {
    const end = lines.findIndex((line, index) => index > begin && line.startsWith(`# <<< dsh-hypercompact preset "${id}"`));
    const stop = end === -1 ? lines.length : end;
    // The inline declaration is the `- insert:` item right after the begin marker.
    let next = begin + 1;
    if (lines[next] === '- insert:' && lines[next + 1]?.trim() === `- id: preset-${id}`) {
      next += 2;
      while (next < stop && (lines[next].startsWith(' ') || lines[next] === '')) next += 1;
      removed.push(`the inline "${id}" preset declaration written by an older create-preset.mjs`);
    }
    // Keep any other rows the plugin manager placed inside the markers.
    const kept = lines.slice(next, stop);
    lines.splice(begin, (end === -1 ? stop : end + 1) - begin, ...kept);
    removed.push('the old marker comments');
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== `- id: preset-${id}`) continue;
    let stop = index + 1;
    while (stop < lines.length && lines[stop].startsWith(' ')) stop += 1;
    const body = lines.slice(index + 1, stop).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
    if (body.length === 1 && body[0] === 'disabled: true') {
      lines.splice(index, stop - index);
      removed.push(`a "preset-${id}" override that disabled the preset`);
      index -= 1;
    }
  }
  let cleaned = lines.join('\n');
  if (removed.length > 0) {
    // A patch with no rows left must still be a YAML list.
    const rows = cleaned.split('\n').filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
    cleaned = rows.length === 0 ? `${cleaned.replace(/\s*$/, '')}\n[]\n` : `${cleaned.replace(/\n{3,}$/, '\n').replace(/\s*$/, '')}\n`;
  }
  return { text: cleaned, removed };
}
