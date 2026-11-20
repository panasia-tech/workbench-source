from hashlib import pbkdf2_hmac
from hmac import compare_digest
from secrets import token_hex


def hash_password(password, salt=None):
    salt = salt or token_hex(16)
    hashed = pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000)
    return f"{salt}:{hashed.hex()}"


def verify_password(password, stored):
    salt, _ = stored.split(":", 1)
    return compare_digest(hash_password(password, salt=salt), stored)
