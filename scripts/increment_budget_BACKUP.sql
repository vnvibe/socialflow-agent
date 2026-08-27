CREATE OR REPLACE FUNCTION public.increment_budget(p_account_id uuid, p_action_type text, p_count integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_budget JSONB; v_cat JSONB; v_used INT; v_max INT; v_reset TIMESTAMPTZ; v_today TIMESTAMPTZ;
BEGIN
  SELECT daily_budget INTO v_budget FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF v_budget IS NULL OR v_budget = '{}'::jsonb THEN v_budget := '{}'::jsonb; END IF;
  v_reset := (v_budget->>'reset_at')::timestamptz;
  v_today := date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_reset IS NULL OR v_reset < v_today THEN
    v_budget := jsonb_build_object('reset_at', v_today::text,
      'like', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'like'->>'max')::int, 80)),
      'comment', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'comment'->>'max')::int, 25)),
      'friend_request', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'friend_request'->>'max')::int, 15)),
      'join_group', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'join_group'->>'max')::int, 3)),
      'post', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'post'->>'max')::int, 5)),
      'scan', jsonb_build_object('used', 0, 'max', COALESCE((v_budget->'scan'->>'max')::int, 10)));
  END IF;
  v_cat := COALESCE(v_budget->p_action_type, jsonb_build_object('used', 0, 'max', 10));
  v_used := COALESCE((v_cat->>'used')::int, 0);
  v_max := COALESCE((v_cat->>'max')::int, 10);
  IF v_used + p_count > v_max THEN
    RETURN jsonb_build_object('allowed', false, 'used', v_used, 'max', v_max, 'action', p_action_type);
  END IF;
  v_cat := jsonb_set(v_cat, '{used}', to_jsonb(v_used + p_count));
  v_budget := jsonb_set(v_budget, ARRAY[p_action_type], v_cat);
  UPDATE accounts SET daily_budget = v_budget WHERE id = p_account_id;
  RETURN jsonb_build_object('allowed', true, 'used', v_used + p_count, 'max', v_max, 'action', p_action_type);
END; $function$
