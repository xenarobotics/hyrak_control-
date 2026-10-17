"""Per-user authentication: users, bearer tokens, roles. See docs/AUTH.md."""
from app.auth.service import AuthUser, authenticate, verify_token  # noqa: F401
