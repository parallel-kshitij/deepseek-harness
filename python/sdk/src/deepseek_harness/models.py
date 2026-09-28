from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from pydantic import BaseModel

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class ServerCapabilities(BaseModel):
    subagentLinks: bool = False
    attachments: bool = False


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None
    capabilities: ServerCapabilities | None = None


class SessionOpenResponse(BaseModel):
    sessionId: str
    disposition: str


class SessionCloseResponse(BaseModel):
    closed: bool


class SessionOutputResponse(BaseModel):
    available: bool
    structuredOutput: object | None = None
