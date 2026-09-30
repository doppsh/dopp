-- Every paid step is recorded at our cost; `billed` says whether the customer pays it (1) or it's on us (0): things the product does on
-- its own that nobody asked for (naming a kind of request, its plan, dataset suggestions). The Usage page shows both, separately.
ALTER TABLE charges ADD COLUMN billed INTEGER NOT NULL DEFAULT 1;
