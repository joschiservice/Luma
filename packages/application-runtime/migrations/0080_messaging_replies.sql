-- A reply Luma sent is recorded on the message the verifying thread read stored, so the
-- inbox can tell Luma's replies from those written in the mailbox itself.
GRANT UPDATE(origin) ON messaging_messages TO luma_desk;
