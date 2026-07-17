// PLANTED DEFECT: a non-atomic read-modify-write on a shared counter from two threads.
// Loom explores all interleavings and finds the one where both read 0 → final is 1, not 2.
#[cfg(loom)]
#[cfg(test)]
mod tests {
    use loom::sync::atomic::{AtomicUsize, Ordering};
    use loom::sync::Arc;
    use loom::thread;
    #[test]
    fn planted_race() {
        loom::model(|| {
            let n = Arc::new(AtomicUsize::new(0));
            let n2 = n.clone();
            let t = thread::spawn(move || {
                let v = n2.load(Ordering::SeqCst);
                n2.store(v + 1, Ordering::SeqCst);
            });
            let v = n.load(Ordering::SeqCst);
            n.store(v + 1, Ordering::SeqCst);
            t.join().unwrap();
            assert_eq!(2, n.load(Ordering::SeqCst));
        });
    }
}
