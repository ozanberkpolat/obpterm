//! What a pane printed, kept so a reattaching window can be shown where the shell is.

use std::collections::VecDeque;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::with_capacity(cap.min(64 * 1024)), cap }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(bytes);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::Ring;

    #[test]
    fn keeps_the_newest_bytes_and_never_exceeds_its_cap() {
        let mut r = Ring::new(8);
        r.push(b"abcde");
        r.push(b"fgh");
        assert_eq!(r.snapshot(), b"abcdefgh");
        r.push(b"ij");
        assert_eq!(r.snapshot(), b"cdefghij", "oldest two dropped");
        r.push(b"0123456789xyz");
        assert_eq!(r.snapshot(), b"56789xyz", "a push bigger than the ring keeps its tail");
        assert_eq!(r.len(), 8);
    }
}
