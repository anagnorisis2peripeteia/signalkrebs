import threading, unittest
# PLANTED DEFECT: a non-reentrant lock acquired twice on one thread → deadlock.
# The stress harness runs this under a timeout + faulthandler and catches the hang.
class Probe(unittest.TestCase):
    def test_planted_deadlock(self):
        lock = threading.Lock()
        lock.acquire()
        lock.acquire()  # deadlock: never returns
