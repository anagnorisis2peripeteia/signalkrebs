import threading, unittest
# CLEAN twin: acquires and releases correctly — completes fast, no deadlock.
class Probe(unittest.TestCase):
    def test_clean(self):
        lock = threading.Lock()
        with lock:
            self.assertTrue(True)
