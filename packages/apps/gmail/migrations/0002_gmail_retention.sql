-- Gmail's tenant tables join the core retention registry, which purges stop on while any tenant
-- table is unclassified. Authorizations, mailbox bindings and push registrations describe the
-- workspace's own mailbox connection, so a closed workspace's purge removes them.
INSERT INTO data_retention_classes(table_name,class) VALUES
 ('gmail_oauth_states','purge_on_closure'),
 ('gmail_mailbox_bindings','purge_on_closure'),
 ('gmail_watches','purge_on_closure');
