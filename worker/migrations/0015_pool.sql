-- v4: a person can pin a request's labels to one upstream's answers from the request pool ("use X's answers as labels");
-- pinned labels survive oracle changes. Account-level catalog picks (LLMs someone added to their upstreams) live in `connections`
-- with kind 'pin' and the upstream id in `model`.
ALTER TABLE examples ADD COLUMN grounded_pinned INTEGER NOT NULL DEFAULT 0;
