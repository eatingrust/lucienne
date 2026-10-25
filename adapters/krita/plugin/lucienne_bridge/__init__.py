# Earliest fixed marker: no account data, paths, payloads or exception details.
try:
    import sys
    sys.stderr.write("LUCIENNE_KRITA_BOOTSTRAP_V1\n")
except Exception:
    pass

from .diagnostics import mark_status

mark_status("module-import")
try:
    from .bridge import LucienneBridge
    from krita import Krita
    mark_status("imports-ready")
    Krita.instance().addExtension(LucienneBridge(Krita.instance()))
except Exception as error:
    mark_status("import-failed", error=error)
    raise
