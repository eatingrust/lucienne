"""Entrypoint for Blender --python; ordinary Blender launches load no bridge."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge import start

start()
