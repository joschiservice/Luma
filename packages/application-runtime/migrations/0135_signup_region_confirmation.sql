-- Choice is validated by authentication before INSERT; evidence commits with account creation.
ALTER TABLE users ADD COLUMN confirmed_data_region text CHECK(confirmed_data_region IN ('EU','AU','US'));
ALTER TABLE users ADD COLUMN region_confirmed_at timestamptz;
CREATE TABLE signup_region_confirmations (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 region text NOT NULL CHECK(region IN ('EU','AU','US')),
 confirmed_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 confirmed_at timestamptz NOT NULL,
 event text NOT NULL DEFAULT 'signup.region-confirmed' CHECK(event='signup.region-confirmed')
);
REVOKE ALL ON signup_region_confirmations FROM PUBLIC;
CREATE FUNCTION identity_record_signup_region() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.confirmed_data_region IS NOT NULL THEN
  IF NEW.confirmed_data_region IS DISTINCT FROM (SELECT region FROM public.luma_cell_region) THEN RAISE EXCEPTION 'signup region unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.signup_region_confirmations(user_id,region,confirmed_by,confirmed_at) VALUES(NEW.id,NEW.confirmed_data_region,NEW.id,clock_timestamp());
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity_record_signup_region() FROM PUBLIC;
CREATE TRIGGER identity_record_signup_region AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION identity_record_signup_region();
