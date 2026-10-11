-- A Luma order line keeps whether its unit price includes tax, as the source order stated it.
-- Prices are never converted between net and gross, so null means the source did not say.
ALTER TABLE sales_order_lines ADD COLUMN tax_included boolean;
