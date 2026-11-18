-- Successful no-Item results must also be replayed. Existing Item references retain their FK.
ALTER TABLE door_proposals ALTER COLUMN item_id DROP NOT NULL;
