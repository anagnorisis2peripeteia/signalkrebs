"""signalkrebs Python concurrency probe: run a package's tests under a deadlock timeout.
On a hang, faulthandler dumps every thread's traceback (header 'Timeout (H:MM:SS)!') to stderr
and exits — the adapter reads that as a deadlock/blocked-forever defect. Prefers pytest, falls
back to stdlib unittest so it runs with no extra deps."""
import faulthandler, os, sys, unittest

target = sys.argv[1]
timeout = float(os.environ.get("SK_TIMEOUT", "10"))
faulthandler.dump_traceback_later(timeout, exit=True)  # hang -> dump all threads + _exit
try:
    import pytest  # type: ignore
    sys.exit(pytest.main([target, "-q", "-p", "no:cacheprovider"]))
except ImportError:
    loader = unittest.defaultTestLoader.discover(target, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=0).run(loader)
    sys.exit(0 if result.wasSuccessful() else 1)
