-- Explicit line equivalence is confined to a previously linked canonical order.
ALTER TABLE commerce_identity_links DROP CONSTRAINT commerce_identity_links_kind_check;
ALTER TABLE commerce_identity_links ADD CONSTRAINT commerce_identity_links_kind_check
 CHECK(kind IN ('sku','location','order','order_line'));
