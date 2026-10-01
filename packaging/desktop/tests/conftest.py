import sys
from pathlib import Path

# Make the launcher modules importable no matter where pytest is started from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
