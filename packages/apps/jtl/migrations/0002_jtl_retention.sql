-- JTL's tenant table joins the core retention registry, which purges stop on while any tenant
-- table is unclassified. Shipping method evidence is provider evidence of the workspace's own
-- connection, so a closed workspace's purge removes it.
INSERT INTO data_retention_classes(table_name,class) VALUES
 ('jtl_shipping_method_evidence','purge_on_closure');
