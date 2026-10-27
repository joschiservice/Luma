-- Restarts of the current scan after the source rejected its cursor. A successful first page
-- clears the failure attempts, so the attempt count cannot stop a cursor that the source
-- rejects on every pass; this count survives those pages and limits the restarts per scan.
-- A suspended history checkpoint keeps its count in its JSON document.
ALTER TABLE commerce_sync_streams ADD COLUMN scan_restarts integer NOT NULL DEFAULT 0;
