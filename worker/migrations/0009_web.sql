-- where a version's browser weights (ONNX fp16 shards) are hosted, once exported; null until then
ALTER TABLE models ADD COLUMN web_url TEXT;
