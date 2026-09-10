#!/usr/bin/env python3
"""Pure/ordinary-file refusal checks; never Linux containment evidence."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "qualification", Path(__file__).with_name("qualify-linux-cgroup.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class ProvisionerRefusal(unittest.TestCase):
    def test_hosted_gate(self):
        env = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
               "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64"}
        qualification.hosted_only(env, "linux", 0)
        for key in env:
            with self.assertRaises(qualification.Refused):
                qualification.hosted_only({**env, key: "wrong"}, "linux", 0)
        for platform, uid in [("darwin", 0), ("linux", 1000)]:
            with self.assertRaises(qualification.Refused):
                qualification.hosted_only(env, platform, uid)

    def test_population_requires_exact_observation(self):
        self.assertFalse(qualification.populated(b"populated 0\nfrozen 0\n"))
        self.assertTrue(qualification.populated(b"populated 1\n"))
        for data in [b"", b"frozen 0", b"populated 2", b"populated 00",
                     b"populated 0\npopulated 1", b"populated 0 extra", b"x" * 4097]:
            with self.assertRaises(qualification.Refused):
                qualification.populated(data)

    def test_removal_refuses_replaced_directory(self):
        with tempfile.TemporaryDirectory() as root:
            parent = os.open(root, os.O_RDONLY)
            try:
                path = Path(root) / "owned"
                path.mkdir()
                group = qualification.Group.__new__(qualification.Group)
                group.parent, group.name, group.events = parent, "owned", None
                group.created_identity = qualification.identity(path.stat())
                # Keep the original inode allocated so replacement cannot reuse it.
                path.rename(Path(root) / "original")
                path.mkdir()
                with self.assertRaises(qualification.Refused):
                    group.remove()
                self.assertTrue(path.is_dir())
                path.rmdir()
                path.symlink_to(Path(root) / "original", target_is_directory=True)
                with self.assertRaises(qualification.Refused):
                    group.remove()
                self.assertTrue(path.is_symlink())
            finally:
                os.close(parent)

    def test_bounded_collect_failure_with_owned_subprocess(self):
        for code, timeout, expected in [
            ("import time; time.sleep(10)", 0.05, "deadline"),
            ("import os, time; os.write(1, b'x' * (128 * 1024)); time.sleep(10)", 2, "output"),
        ]:
            child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
            try:
                with self.assertRaisesRegex(qualification.Refused, expected):
                    qualification.collect(child, time.monotonic() + timeout)
            finally:
                child.kill()
                child.wait(timeout=5)
                child.stdout.close()
                child.stderr.close()
            self.assertIsNotNone(child.returncode)

    if sys.platform == "linux":
        # Actual pidfd cleanup only runs on Linux; macOS collector checks above
        # must not be counted as this platform-specific execution evidence.
        def test_linux_finally_cleans_after_timeout_and_output_cap(self):
            for code, timeout, expected in [
                ("import time; time.sleep(10)", 0.05, "deadline"),
                ("import os, time; os.write(2, b'x' * (128 * 1024)); time.sleep(10)", 2, "output"),
            ]:
                with tempfile.TemporaryDirectory() as root:
                    # Ordinary files are a test double for stop invocation only.
                    # No cgroup is read, created or changed by this test.
                    with tempfile.TemporaryFile() as first, tempfile.TemporaryFile() as second, tempfile.TemporaryFile() as third:
                        observations = []
                        group = SimpleNamespace(directory=first.fileno(), procs=second.fileno(),
                                                kill=third.fileno(), stop=lambda: observations.append("stop"))
                        real_popen = subprocess.Popen
                        children = []

                        def spawn(*args, **kwargs):
                            child = real_popen(*args, **kwargs)
                            children.append(child)
                            return child

                        with patch.object(qualification.subprocess, "Popen", side_effect=spawn):
                            with self.assertRaisesRegex(qualification.Refused, expected):
                                qualification.owned_fixture([sys.executable, "-c", code], root, group,
                                                            lambda _: self.fail("unexpected completion"), timeout)
                        self.assertEqual(observations, ["stop"])
                        self.assertEqual(children[0].returncode, -signal.SIGKILL)
                        self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)


if __name__ == "__main__":
    unittest.main()
