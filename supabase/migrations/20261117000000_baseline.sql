-- Observed legacy schema (architecture.md, 39 columns / 20 constraints).
-- Empty databases only. Existing installations must compare the schema first,
-- then record ONLY this baseline as applied; never replay it over existing tables.
BEGIN;
CREATE TABLE public.users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  auth_id uuid UNIQUE,
  name varchar(100) NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.leagues (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name varchar(100) NOT NULL,
  owner_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.league_members (
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  role varchar(20) DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (league_id, user_id)
);
CREATE TABLE public.seasons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  start_date date,
  end_date date,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  default_points integer DEFAULT 25000,
  return_points integer DEFAULT 30000,
  uma_1 integer NOT NULL,
  uma_2 integer NOT NULL,
  uma_3 integer NOT NULL,
  uma_4 integer NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.matches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  season_id uuid REFERENCES public.seasons(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.rules(id),
  recorded_by uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.match_results (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id uuid REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id),
  raw_score integer NOT NULL,
  final_point numeric(6,1) NOT NULL,
  rank integer NOT NULL CHECK (rank >= 1 AND rank <= 4),
  UNIQUE (match_id, user_id)
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;
COMMIT;
