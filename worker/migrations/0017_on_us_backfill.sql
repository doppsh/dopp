-- Charges recorded before `billed` existed for work the product does on its own (naming a kind of request, its plan) were counted as
-- billed. They're on us, like the same work from now on (ledger.js ON_US).
UPDATE charges SET billed = 0 WHERE note IN ('naming', 'plan', 'suggest');
