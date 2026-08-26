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
        // Keep a short tail in case an ESC [ ? is split across the boundary.
        let keep = buf.len().saturating_sub(8);
        self.carry = buf[keep..].to_vec();
        let _ = last_esc;
    }

    /// `CSI ? n h` for every mode that is on, in one string — what to write before a replay.
    pub fn reassert(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for m in &self.on {
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
        assert_eq!(String::from_utf8(m.reassert()).unwrap(), "\x1b[?1006h\x1b[?1049h\x1b[?2004h");
        m.track(b"\x1b[?2004l\x1b[?1049l\x1b[?1006l");
        assert!(m.reassert().is_empty());
    }
}
