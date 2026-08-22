import importlib.util
import os
import tempfile
import unittest


SCRIPT = os.path.join(os.path.dirname(__file__), "upload-playstore.py")
SPEC = importlib.util.spec_from_file_location("upload_playstore", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UploadPlayStoreTest(unittest.TestCase):
    def test_default_gradle_fallback_is_the_real_mobile_app(self):
        self.assertTrue(MODULE.DEFAULT_GRADLE_PATH.endswith(
            os.path.join("mobile", "android", "app", "build.gradle")
        ))
        self.assertIsNotNone(MODULE.read_gradle_version_code(
            MODULE.DEFAULT_GRADLE_PATH
        ))

    def test_read_gradle_version_code(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as fixture:
            fixture.write("defaultConfig { versionCode 417 }\n")
            path = fixture.name
        try:
            self.assertEqual(MODULE.read_gradle_version_code(path), 417)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
