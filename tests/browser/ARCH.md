# Real browser integration

dbsonl.worker.ts is bundled only into artifacts/ for end-to-end execution. It imports the built DataView entries, real DBSONL, real Storage OPFS and navigator.locks. It verifies snapshot isolation and generation pin cleanup while mutations and compaction occur. No storage/runtime subsystem is mocked.
