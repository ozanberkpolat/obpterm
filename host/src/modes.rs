//! Which DEC private modes a program has switched on. A replay ring holds the last megabyte;
//! the `CSI ? 2004 h` that enabled bracketed paste at startup scrolled out of it long ago, so a
//! reattached terminal would paste multi-line text as separate commands. Tracking the modes and
//! re-asserting them before the replay is what makes the replayed screen behave like the live one.

use std::collections::BTreeSet;

#[derive(Default, Debug)]
pub struct Modes {
    on: BTreeSet<u16>,
    /// The tail of the previous chunk, so a sequence split across two reads still parses.
    carry: Vec<u8>,
}

impl Modes {
    pub fn track(&mut self, bytes: &[u8]) {
        // The common case by far: nothing was carried over, and the chunk holds no ESC at all —
        // ordinary program output. Every pty read of every session passes through here, so the
        // old unconditional `carry + extend_from_slice` copied up to 16 KB per read for a
        // feature that only cares about a handful of rare escape bytes.
        if self.carry.is_empty() && !bytes.contains(&0x1b) {
            return;
        }
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut i = 0;
        let mut last_esc = None;
        while i + 2 < buf.len() {
            if buf[i] == 0x1b && buf[i + 1] == b'[' && buf[i + 2] == b'?' {
                last_esc = Some(i);
                let mut j = i + 3;
                let mut nums: Vec<u16> = Vec::new();
                let mut cur: Option<u32> = None;
                let mut done = false;
                while j < buf.len() {
                    match buf[j] {
                        b'0'..=b'9' => cur = Some(cur.unwrap_or(0) * 10 + (buf[j] - b'0') as u32),
                        b';' => {
                            if let Some(n) = cur.take() { nums.push(n.min(u16::MAX as u32) as u16); }
                        }
                        b'h' | b'l' => {
                            if let Some(n) = cur.take() { nums.push(n.min(u16::MAX as u32) as u16); }
                            for n in nums.drain(..) {
                                if buf[j] == b'h' { self.on.insert(n); } else { self.on.remove(&n); }
                            }
                            done = true;
                            j += 1;
                            break;
                        }
                        _ => { j += 1; break; } // not a mode sequence after all
                    }
                    j += 1;
                }
                if !done && j >= buf.len() {
                    // Ran off the end mid-sequence: keep it for the next chunk.
                    self.carry = buf[i..].to_vec();
                    return;
                }
                i = j;
                continue;
            }
            i += 1;
        }
        // Keep a short tail only when it could actually be the start of a split sequence —
        // otherwise the next chunk pays for a copy that can never match anything.
        let keep = buf.len().saturating_sub(8);
        self.carry = if buf[keep..].contains(&0x1b) { buf[keep..].to_vec() } else { Vec::new() };
        let _ = last_esc;
    }

    /// Mouse tracking. Never replayed, and this is not a detail: re-asserting it tells a
    /// freshly built terminal to report the pointer to a program that may have left mouse mode
    /// long ago — every movement then types `\x1b[<35;43;16M` into that program, which echoes
    /// it as text, which is output, which repaints. That loop is what made the window seize
    /// after v0.21.12 taught panes to sleep and re-attach many times an hour. A program that
    /// still wants the mouse switches it on again in the repaint the attach resize triggers.
    const INPUT_MODES: &[u16] = &[1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016];

    /// `CSI ? n h` for the DISPLAY modes that are on, in one string — what to write before a
    /// replay. Display state (bracketed paste, alt screen, wrap, cursor) is what the ring no
    /// longer holds; input state belongs to the program, not to our record of it.
    pub fn reassert(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for m in &self.on {
            if Self::INPUT_MODES.contains(m) {
                continue;
            }
            out.extend_from_slice(format!("\x1b[?{m}h").as_bytes());
        }
        out
    }

    pub fn is_on(&self, mode: u16) -> bool {
        self.on.contains(&mode)
    }
}

#[cfg(test)]
mod tests {
    use super::Modes;

    #[test]
    fn plain_output_is_not_copied_and_a_split_sequence_still_survives_it() {
        let mut m = Modes::default();
        // Megabytes of ordinary output must leave no carry behind — that copy was per read,
        // per session, for nothing.
        m.track(&vec![b'x'; 16 * 1024]);
        assert!(m.carry.is_empty(), "plain output carries nothing forward");
        // And the boundary case the carry exists for still works.
        m.track(b"before \x1b[?20");
        assert!(!m.carry.is_empty(), "a half-finished sequence IS carried");
        m.track(b"04h after");
        assert!(m.is_on(2004), "the split sequence still lands");
        m.track(&vec![b'y'; 4096]);
        assert!(m.is_on(2004) && m.carry.is_empty(), "and plain output after it changes nothing");
    }

    #[test]
    fn mouse_tracking_is_tracked_but_never_replayed() {
        // The seize: a replayed `\x1b[?1002h` arms the new terminal, the program is not in
        // mouse mode any more, and every pointer movement is typed into it as text.
        let mut m = Modes::default();
        m.track(b"\x1b[?2004h\x1b[?1002;1006h\x1b[?1049h");
        assert!(m.is_on(1002) && m.is_on(1006), "we still KNOW what the program asked for");
        let replay = String::from_utf8(m.reassert()).unwrap();
        assert!(replay.contains("\x1b[?2004h") && replay.contains("\x1b[?1049h"), "display modes come back");
        for mouse in ["1000", "1001", "1002", "1003", "1005", "1006", "1015", "1016"] {
            assert!(!replay.contains(&format!("\x1b[?{mouse}h")), "{mouse} must never be replayed: {replay:?}");
        }
    }

    #[test]
    fn tracks_set_and_reset_including_across_a_chunk_boundary() {
        let mut m = Modes::default();
        m.track(b"hello \x1b[?2004h\x1b[?1000;1006h world");
        assert!(m.is_on(2004) && m.is_on(1000) && m.is_on(1006));
        m.track(b"\x1b[?1000l");
        assert!(!m.is_on(1000) && m.is_on(1006));
        // Split: the sequence straddles two reads.
        m.track(b"text \x1b[?10");
        m.track(b"49h more");
        assert!(m.is_on(1049), "a sequence split across reads still counts");
        assert_eq!(String::from_utf8(m.reassert()).unwrap(), "\x1b[?1049h\x1b[?2004h");
        m.track(b"\x1b[?2004l\x1b[?1049l\x1b[?1006l");
        assert!(m.reassert().is_empty());
    }
}
