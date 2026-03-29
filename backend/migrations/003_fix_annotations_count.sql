-- 003_fix_annotations_count.sql
-- Adds a simple RPC to atomically increment the lifetime annotation_count.
-- Called from the annotate API after each successful annotation response,
-- with p_count = number of annotations returned to the user.

CREATE OR REPLACE FUNCTION increment_annotation_count(
  p_user_id uuid,
  p_count int
) RETURNS void AS $$
BEGIN
  UPDATE profiles
  SET annotation_count = annotation_count + p_count
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
