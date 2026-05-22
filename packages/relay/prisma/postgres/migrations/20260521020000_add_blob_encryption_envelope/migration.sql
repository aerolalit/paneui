-- Envelope encryption-at-rest opt-in column on blobs. NULL when the relay's
-- BLOB_ENCRYPT_AT_REST is off (the default). When set, the bytes in the
-- configured BlobStore are ciphertext; this column carries the wrapped DEK
-- + data IV + data tag needed to decrypt them.
--
-- Storage is a base64-encoded JSON envelope (not three separate columns)
-- so future versions of the encryption scheme — customer-managed keys, key
-- rotation, etc. — can extend the shape without another migration.
ALTER TABLE "blobs" ADD COLUMN "encryption_envelope" TEXT;
