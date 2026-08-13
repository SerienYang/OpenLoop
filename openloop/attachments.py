"""Build OpenAI content-parts from a user message + attachments (images, PDFs, text files).

We pass messages straight to the OpenAI SDK, which accepts `content` as either a string or an
array of parts: `{"type": "text", ...}`, `{"type": "image_url", "image_url": {"url": ...}}`
(data: URLs work, and vision models read them), and `{"type": "file", "file": {"filename",
"file_data"}}` for PDFs. So image/PDF attachments are just parts appended to the user turn —
the Anthropic/Gemini providers convert them to their own block shapes.

`build_user_content` returns a plain string when there are no attachments (back-compat with the
text-only path), else the parts list.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

MAX_ATTACHMENTS = 8
MAX_ATTACHMENTS_BYTES = 15_000_000
MAX_IMAGE_CHARS = 12_000_000  # data-URL length cap (~8–9 MB decoded); keeps a turn sane
MAX_PDF_CHARS = 15_000_000  # data-URL length cap (~10 MB decoded, the GUI's pick limit)
MAX_TEXT_CHARS = 200_000  # per text file, inlined
MAX_NAME_CHARS = 1024
MAX_MIME_CHARS = 255


@dataclass(frozen=True)
class AttachmentValidation:
    attachments: list[dict[str, Any]]
    error: Optional[str] = None


def _json_value_size(value: Any) -> int:
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, dict):
        return sum(_json_value_size(k) + _json_value_size(v) for k, v in value.items())
    if isinstance(value, list):
        return sum(_json_value_size(v) for v in value)
    return 8


def _is_data_image(url: Any) -> bool:
    return isinstance(url, str) and url.startswith("data:image/") and ";base64," in url


def _is_data_pdf(url: Any) -> bool:
    return isinstance(url, str) and url.startswith("data:application/pdf;base64,")


def validate_attachments(value: Any) -> AttachmentValidation:
    """Validate the shared wire shape used by user messages and question answers."""
    if value is None:
        return AttachmentValidation([])
    if not isinstance(value, list):
        return AttachmentValidation([], "Invalid attachments: expected a list.")
    if len(value) > MAX_ATTACHMENTS:
        return AttachmentValidation(
            [], f"Too many attachments ({len(value)}; limit {MAX_ATTACHMENTS})."
        )
    if _json_value_size(value) > MAX_ATTACHMENTS_BYTES:
        return AttachmentValidation(
            [], "Attachments too large (limit 15 MB per message)."
        )

    attachments: list[dict[str, Any]] = []
    for attachment in value:
        if not isinstance(attachment, dict):
            return AttachmentValidation([], "Invalid attachment: expected an object.")
        kind = attachment.get("kind")
        name = attachment.get("name")
        mime = attachment.get("mime")
        if kind not in {"image", "pdf", "text"}:
            return AttachmentValidation([], "Invalid attachment kind.")
        if name is not None and (
            not isinstance(name, str) or len(name) > MAX_NAME_CHARS
        ):
            return AttachmentValidation([], "Invalid attachment name.")
        if mime is not None and (
            not isinstance(mime, str) or len(mime) > MAX_MIME_CHARS
        ):
            return AttachmentValidation([], "Invalid attachment MIME type.")
        if kind == "image":
            data = attachment.get("data_url")
            if (
                not _is_data_image(data)
                or not isinstance(data, str)
                or len(data) > MAX_IMAGE_CHARS
            ):
                return AttachmentValidation(
                    [], "Invalid or oversized image attachment."
                )
        elif kind == "pdf":
            data = attachment.get("data_url")
            if (
                not _is_data_pdf(data)
                or not isinstance(data, str)
                or len(data) > MAX_PDF_CHARS
            ):
                return AttachmentValidation(
                    [], "Invalid or oversized PDF attachment."
                )
        else:
            body = attachment.get("text")
            if not isinstance(body, str) or not body or len(body) > MAX_TEXT_CHARS:
                return AttachmentValidation(
                    [], "Invalid or oversized text attachment."
                )
        attachments.append(dict(attachment))
    return AttachmentValidation(attachments)


def build_user_content(
    text: Optional[str], attachments: Optional[list[dict]] = None
) -> Any:
    """Return `str` (no attachments) or a list of OpenAI content-parts (with attachments).

    Each attachment is `{"kind": "image"|"pdf"|"text", "name"?, "data_url"? (image/pdf),
    "text"? (text)}`.
    Invalid/oversized attachments are skipped rather than failing the turn.
    """
    text = (text or "").strip()
    attachments = attachments or []
    if not attachments:
        return text

    parts: list[dict[str, Any]] = []
    if text:
        parts.append({"type": "text", "text": text})

    added = 0  # attachment parts that actually made it in
    for a in attachments[:MAX_ATTACHMENTS]:
        if not isinstance(a, dict):
            continue
        kind = a.get("kind")
        if kind == "image":
            url = a.get("data_url") or ""
            if _is_data_image(url) and len(url) <= MAX_IMAGE_CHARS:
                parts.append({"type": "image_url", "image_url": {"url": url}})
                added += 1
        elif kind == "pdf":
            url = a.get("data_url") or ""
            if _is_data_pdf(url) and len(url) <= MAX_PDF_CHARS:
                name = str(a.get("name") or "attachment.pdf")
                parts.append(
                    {"type": "file", "file": {"filename": name, "file_data": url}}
                )
                added += 1
        elif kind == "text":
            body = str(a.get("text") or "")[:MAX_TEXT_CHARS]
            name = str(a.get("name") or "attachment")
            if body:
                parts.append(
                    {"type": "text", "text": f"[Attached file: {name}]\n{body}"}
                )
                added += 1

    if added == 0:
        return text  # every attachment was invalid/empty → just the text (possibly "")
    return parts


def content_to_text(content: Any, *, image_placeholder: str = "[image]") -> str:
    """Flatten message content (string or parts) to text — for titles, previews, search.
    Images render as `image_placeholder` (pass "" to drop them, e.g. for clean titles).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                out.append(str(part.get("text", "")))
            elif part.get("type") == "image_url" and image_placeholder:
                out.append(image_placeholder)
            elif part.get("type") == "file" and image_placeholder:
                out.append("[pdf]")
        return " ".join(out).strip()
    return ""
