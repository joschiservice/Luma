-- Immutable snapshot provenance must resolve within the same tenant and connection.
ALTER TABLE orders_snapshots
 ADD CONSTRAINT orders_snapshot_observation_fk
 FOREIGN KEY(tenant_id,connection_id,observation_id)
 REFERENCES connector_observations(tenant_id,connection_id,id) ON DELETE RESTRICT;

ALTER TABLE inventory_snapshots
 ADD CONSTRAINT inventory_snapshot_observation_fk
 FOREIGN KEY(tenant_id,connection_id,observation_id)
 REFERENCES connector_observations(tenant_id,connection_id,id) ON DELETE RESTRICT;
