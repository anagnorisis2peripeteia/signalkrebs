#[cfg(loom)]
#[cfg(test)]
mod tests {
    use loom::sync::atomic::{AtomicUsize, Ordering};
    use loom::sync::Arc;
    use loom::thread;
    #[test]
    fn clean_atomic() {
        loom::model(|| {
            let n = Arc::new(AtomicUsize::new(0));
            let n2 = n.clone();
            let t = thread::spawn(move || { n2.fetch_add(1, Ordering::SeqCst); });
            n.fetch_add(1, Ordering::SeqCst);
            t.join().unwrap();
            assert_eq!(2, n.load(Ordering::SeqCst));
        });
    }
}
