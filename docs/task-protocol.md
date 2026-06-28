# Task Management Protocol — moved

The canonical notestr task protocol no longer lives in this client repo. It is
owned by the parent `notestr` repo:

> **`../../protocol/task-protocol.md`** (relative to this file:
> `notestr/protocol/task-protocol.md`)

Do **not** edit a protocol definition here. `notestr-web` is one implementation
of the shared contract; changing the wire format or convergence rules in a
single client is what caused the web↔CLI divergence. Protocol changes originate
in the parent — see `notestr/protocol/README.md` for the change process.

This stub remains only so existing in-repo references to `docs/task-protocol.md`
keep resolving.
