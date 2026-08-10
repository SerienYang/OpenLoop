"""Address guard for URLs the model chooses.

`web_fetch` and `browser_read_url` take a URL straight from the model, and the model's
input is untrusted by design — it reads web pages, email and Slack messages, all of which
are documented as "data, not instructions". A page that talks the agent into fetching
`http://169.254.169.254/` or `http://127.0.0.1:11434/` turns a read-only research tool into
a probe of the machine's own network position, and `web_fetch` is `requires_approval=False`,
so no prompt ever appears.

This blocks the ranges that are only reachable *because* OpenLoop runs on the user's
machine: loopback, RFC1918 and other private space, link-local (which covers the cloud
metadata endpoint at 169.254.169.254), and the reserved/multicast blocks.

Every hop is checked, not just the first: `follow_redirects=True` otherwise lets a public
URL 302 straight to loopback, which is the standard way this filter is bypassed.

Not covered: DNS rebinding. The name is resolved here and resolved again by the client when
it connects, so a record with a ~0 TTL can change between the two. Closing that needs
connection-level IP pinning; the hop check is the cheap 90% and is stated as such.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Any, Optional
from urllib.parse import urlsplit

MAX_REDIRECTS = 5

# RFC 6598 shared address space. Python's is_private misses it, but it is carrier grade
# NAT space and Tailscale hands out internal hosts here (100.64.0.0/10), so a fetch to it
# is the same "reach the machine's network position" class as RFC1918.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _blocked_reason(ip: ipaddress._BaseAddress) -> Optional[str]:
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local (includes the cloud metadata endpoint)"
    if ip.is_private:
        return "a private network"
    if ip.version == 4 and ip in _CGNAT:
        return "shared address space (CGNAT / RFC 6598)"
    if ip.is_multicast:
        return "multicast"
    if ip.is_reserved or ip.is_unspecified:
        return "a reserved range"
    return None


def _resolve_public_host(host: str, port: int) -> tuple[Optional[str], Optional[str]]:
    """Resolve once and return a public IP literal plus an optional refusal reason."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        mapped = getattr(literal, "ipv4_mapped", None)
        address = mapped if mapped is not None else literal
        reason = _blocked_reason(address)
        if reason:
            return None, f"refusing to fetch {host}: {reason}"
        return str(address), None

    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        return None, f"could not resolve {host}: {exc}"

    public: list[str] = []
    for info in infos:
        raw = info[4][0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        mapped = getattr(ip, "ipv4_mapped", None)
        address = mapped if mapped is not None else ip
        reason = _blocked_reason(address)
        if reason:
            return None, f"refusing to fetch {host} ({address}): {reason}"
        public.append(str(address))
    if not public:
        return None, f"could not resolve {host}: no usable address"
    return public[0], None


def check_url(url: str) -> Optional[str]:
    """None if the URL may be fetched, else a human-readable refusal reason.

    Resolves the host and rejects when *any* answer lands in a blocked range, so a name
    with both a public and a private A record cannot be used to slip through.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return "url must start with http:// or https://"
    host = parts.hostname
    if not host:
        return "url has no host"

    _, reason = _resolve_public_host(
        host, parts.port or (443 if parts.scheme == "https" else 80)
    )
    return reason


class GuardedNetworkBackend:
    """httpcore backend that connects to the exact address it validates.

    httpcore still owns TLS and passes the original hostname to SNI/certificate
    verification. Only the TCP destination is replaced with the checked IP literal.
    """

    def __init__(self, backend: Any = None) -> None:
        if backend is None:
            import httpcore

            backend = httpcore.SyncBackend()
        self._backend = backend

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: Optional[float] = None,
        local_address: Optional[str] = None,
        socket_options: Any = None,
    ):
        ip, reason = _resolve_public_host(host, port)
        if reason or ip is None:
            raise PermissionError(reason or f"could not resolve {host}")
        return self._backend.connect_tcp(
            ip,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    def connect_unix_socket(self, path: str, **kwargs: Any):
        return self._backend.connect_unix_socket(path, **kwargs)

    def sleep(self, seconds: float) -> None:
        self._backend.sleep(seconds)


def guarded_http_transport():
    """Build an httpx transport backed by :class:`GuardedNetworkBackend`."""
    import httpcore
    import httpx

    transport = httpx.HTTPTransport()
    transport._pool = httpcore.ConnectionPool(  # type: ignore[attr-defined]
        ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
        network_backend=GuardedNetworkBackend(),
    )
    return transport


def get_checked(client, url: str, *, max_redirects: int = MAX_REDIRECTS):
    """GET `url`, validating the address before every hop.

    `client` must be built with `follow_redirects=False`; redirects are walked here so each
    Location is checked. Returns the final response. Raises `PermissionError` when a hop is
    refused, `RuntimeError` when the redirect budget is exhausted.
    """
    seen = url
    for _ in range(max_redirects + 1):
        reason = check_url(seen)
        if reason:
            raise PermissionError(reason)
        resp = client.get(seen)
        if resp.status_code not in (301, 302, 303, 307, 308):
            return resp
        location = resp.headers.get("location")
        if not location:
            return resp
        seen = str(resp.url.join(location))
    raise RuntimeError(f"too many redirects (>{max_redirects})")
