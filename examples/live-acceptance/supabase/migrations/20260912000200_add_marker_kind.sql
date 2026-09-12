alter table public.deploytruth_acceptance_markers
  add column kind text not null default 'acceptance';
