// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for {text, header}, but much faster.
//
// Strategy: the reference reads one character at a time and builds every
// field a character at a time. This parser instead jumps with indexOf and
// slices whole fields at once, and only falls back to piece-by-piece work
// where the text is actually broken (stray CRs, doubled quotes, CRs inside
// quoted fields). No regex, no split, no per-character loop on the hot path.
//
// Semantics (csv-reader 1.0.0, kept exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; each CRLF or lone CR inside it reads as LF;
//   what follows its closing quote up to the next comma or line break is
//   appended as it stands (quote_junk, when the field ends); a quote that
//   never closes is a literal character and the text after it is read again
//   as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with "" (short_row, with fields: its count) or cut (long_row, with
//   extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; a record's short_row
//   or long_row when it ends: line the 1-based line its record starts on,
//   counting every LF, CRLF and lone CR inside quotes, and row its record's
//   index in rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Field readers report through these.
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and (for the unquoted
  // reader) how many characters it added past its starting value.
  let fval = '';
  let fend = END;
  let fadded = 0;

  // Reads unquoted characters from pos, starting from `init`, up to the next
  // comma or line break: a CR not followed by LF is dropped (stray_cr).
  // Sets fval, fend and fadded (characters appended past `init`).
  // Single forward scan: one charCodeAt per character, slice the field once
  // it ends, so a normal field costs one scan plus one slice.
  function readUnquoted(init) {
    let added = 0;
    let parts = init === '' ? null : [init];
    let start = pos;
    for (;;) {
      let i = pos;
      let code = 0;
      while (i < len) {
        code = text.charCodeAt(i);
        // Delimiters are 44 (','), 10 (LF) and 13 (CR): one range check
        // covers the two line breaks, so most characters take two compares.
        if (code === 44 || (code >= 10 && code <= 13 && code !== 11 && code !== 12)) break;
        i += 1;
      }
      if (i >= len) {
        if (i > start) {
          const piece = text.slice(start, i);
          if (parts === null) parts = [piece];
          else parts.push(piece);
          added += i - start;
        }
        fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
        fadded = added;
        pos = len;
        fend = END;
        return;
      }
      if (code === 44) {
        if (i > start) {
          const piece = text.slice(start, i);
          if (parts === null) parts = [piece];
          else parts.push(piece);
          added += i - start;
        }
        fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
        fadded = added;
        pos = i + 1;
        fend = COMMA;
        return;
      }
      if (code === 10) {
        if (i > start) {
          const piece = text.slice(start, i);
          if (parts === null) parts = [piece];
          else parts.push(piece);
          added += i - start;
        }
        fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
        fadded = added;
        pos = i + 1;
        line += 1;
        fend = LINE_BREAK;
        return;
      }
      // code === 13: CRLF ends the field, a lone CR is dropped.
      if (text.charCodeAt(i + 1) === 10) {
        if (i > start) {
          const piece = text.slice(start, i);
          if (parts === null) parts = [piece];
          else parts.push(piece);
          added += i - start;
        }
        fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
        fadded = added;
        pos = i + 2;
        line += 1;
        fend = LINE_BREAK;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (i > start) {
        const piece = text.slice(start, i);
        if (parts === null) parts = [piece];
        else parts.push(piece);
        added += i - start;
      }
      pos = i + 1;
      start = pos;
    }
  }

  // The processed content of text[a..b) inside a quoted field: each CRLF or
  // lone CR reads as LF, and every LF, CRLF and lone CR counts a line.
  function processSegment(a, b) {
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1) {
      let nl = 0;
      let idx = seg.indexOf('\n');
      while (idx !== -1) {
        nl += 1;
        idx = seg.indexOf('\n', idx + 1);
      }
      line += nl;
      return seg;
    }
    // A CR is present: rebuild with each CR or CRLF as one LF.
    const parts = [];
    let s = 0;
    let cr = seg.indexOf('\r');
    while (cr !== -1) {
      let nl = 0;
      let idx = seg.indexOf('\n', s);
      while (idx !== -1 && idx < cr) {
        nl += 1;
        idx = seg.indexOf('\n', idx + 1);
      }
      line += nl;
      if (cr > s) parts.push(seg.slice(s, cr));
      parts.push('\n');
      line += 1;
      s = cr + 1;
      if (seg.charCodeAt(s) === 10) s += 1; // CRLF: skip the LF
      cr = seg.indexOf('\r', s);
    }
    if (s < seg.length) {
      let nl = 0;
      let idx = seg.indexOf('\n', s);
      while (idx !== -1) {
        nl += 1;
        idx = seg.indexOf('\n', idx + 1);
      }
      line += nl;
      parts.push(seg.slice(s));
    }
    return parts.join('');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fval and fend.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let qp = pos + 1;
    let segStart = qp;
    let parts = null;
    for (;;) {
      const q = text.indexOf('"', qp);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote, and the field goes on.
        const piece = processSegment(segStart, q);
        if (parts === null) parts = [piece, '"'];
        else {
          parts.push(piece);
          parts.push('"');
        }
        qp = q + 2;
        segStart = qp;
        continue;
      }
      // The closing quote.
      const piece = processSegment(segStart, q);
      if (parts === null) fval = piece;
      else {
        parts.push(piece);
        fval = parts.join('');
      }
      pos = q + 1;
      if (pos >= len) {
        fend = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fend = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fend = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fend = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(fval);
      if (fadded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        readQuoted();
      } else {
        lastQuoted = false;
        // Inline unquoted field (init ''): the hot path, kept in the loop
        // so V8 need not call out per field. Same logic as readUnquoted,
        // without the `added` count (only quote-junk needs it, and that
        // path calls readUnquoted itself).
        let start = pos;
        let parts = null;
        for (;;) {
          let i = pos;
          let code = 0;
          while (i < len) {
            code = text.charCodeAt(i);
            if (code === 44 || (code >= 10 && code <= 13 && code !== 11 && code !== 12)) break;
            i += 1;
          }
          if (i >= len) {
            if (i > start) {
              const piece = text.slice(start, i);
              if (parts === null) parts = [piece];
              else parts.push(piece);
            }
            fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
            pos = len;
            fend = END;
            break;
          }
          if (code === 44) {
            if (i > start) {
              const piece = text.slice(start, i);
              if (parts === null) parts = [piece];
              else parts.push(piece);
            }
            fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
            pos = i + 1;
            fend = COMMA;
            break;
          }
          if (code === 10) {
            if (i > start) {
              const piece = text.slice(start, i);
              if (parts === null) parts = [piece];
              else parts.push(piece);
            }
            fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
            pos = i + 1;
            line += 1;
            fend = LINE_BREAK;
            break;
          }
          // code === 13: CRLF ends the field, a lone CR is dropped.
          if (text.charCodeAt(i + 1) === 10) {
            if (i > start) {
              const piece = text.slice(start, i);
              if (parts === null) parts = [piece];
              else parts.push(piece);
            }
            fval = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
            pos = i + 2;
            line += 1;
            fend = LINE_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (i > start) {
            const piece = text.slice(start, i);
            if (parts === null) parts = [piece];
            else parts.push(piece);
          }
          pos = i + 1;
          start = pos;
        }
      }
      fields.push(fval);
    } while (fend === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
