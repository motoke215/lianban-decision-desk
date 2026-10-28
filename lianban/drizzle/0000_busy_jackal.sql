CREATE TABLE `abnormal_watches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`board_type` text DEFAULT 'main' NOT NULL,
	`stock_chg` text DEFAULT '[]' NOT NULL,
	`index_chg` text DEFAULT '[]' NOT NULL,
	`turnover` text,
	`dev3` real,
	`dev10` real,
	`dev30` real,
	`events10` integer,
	`turnover_state` text DEFAULT 'nodata' NOT NULL,
	`level` text DEFAULT 'calm' NOT NULL,
	`gap_points` real,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backtest_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track` text NOT NULL,
	`date` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`recommended` integer,
	`veto_hit` integer,
	`success_pick` integer,
	`auction_gain_pct` real,
	`auction_vol_ratio` real,
	`board_days` integer,
	`closed_limit` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backtest_track_date_code` ON `backtest_rows` (`track`,`date`,`code`);--> statement-breakpoint
CREATE TABLE `breadth_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`up` integer,
	`down` integer,
	`flat` integer,
	`red_pct` real,
	`trin_amt` real,
	`trin_vol` real,
	`stage` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `breadth_records_date_unique` ON `breadth_records` (`date`);--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`flag_clarify` integer DEFAULT 0 NOT NULL,
	`flag_top_break` integer DEFAULT 0 NOT NULL,
	`flag_theme_ebb` integer DEFAULT 0 NOT NULL,
	`flag_external` integer DEFAULT 0 NOT NULL,
	`s_theme` integer DEFAULT 0 NOT NULL,
	`s_position` integer DEFAULT 0 NOT NULL,
	`s_seal` integer DEFAULT 0 NOT NULL,
	`s_turnover` integer DEFAULT 0 NOT NULL,
	`s_follow` integer DEFAULT 0 NOT NULL,
	`auction_gain_pct` real,
	`auction_amount_wan` real,
	`auction_vol_ratio` real,
	`board_days` integer,
	`yday_state` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `confirm_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`cond_premium` text DEFAULT 'unknown' NOT NULL,
	`cond_seal` text DEFAULT 'unknown' NOT NULL,
	`cond_leader` text DEFAULT 'unknown' NOT NULL,
	`gap_filled` integer DEFAULT 0 NOT NULL,
	`danger` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `confirm_states_date_unique` ON `confirm_states` (`date`);--> statement-breakpoint
CREATE TABLE `fundflow_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`net_yuan` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundflow_date_kind_name` ON `fundflow_records` (`date`,`kind`,`name`);--> statement-breakpoint
CREATE TABLE `intraday_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`event_ts` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`fact_text` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intraday_ts_code_type` ON `intraday_events` (`event_ts`,`code`,`type`);--> statement-breakpoint
CREATE TABLE `ladder_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`board_days` integer DEFAULT 1 NOT NULL,
	`role` text DEFAULT 'other' NOT NULL,
	`is_spatial` integer DEFAULT 0 NOT NULL,
	`sig_break_volume_down` integer DEFAULT 0 NOT NULL,
	`sig_multi_open_late_seal` integer DEFAULT 0 NOT NULL,
	`sig_second_collapse` integer DEFAULT 0 NOT NULL,
	`sig_clarify_deny` integer DEFAULT 0 NOT NULL,
	`sig_drive_loss` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ladder_date_code` ON `ladder_entries` (`date`,`code`);--> statement-breakpoint
CREATE TABLE `market_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`max_board` integer,
	`limit_up_count` integer,
	`limit_down_count` integer,
	`broken_rate` real,
	`prev_premium_pct` real,
	`promotion_rate_pct` real,
	`seal_rate_pct` real,
	`cycle_stage` text DEFAULT '' NOT NULL,
	`max_drop` integer,
	`ladder_gap` integer DEFAULT 0 NOT NULL,
	`ebb_signal` integer DEFAULT 0 NOT NULL,
	`main_themes` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_days_date_unique` ON `market_days` (`date`);--> statement-breakpoint
CREATE TABLE `plan_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`themes` text DEFAULT '' NOT NULL,
	`watchlist` text DEFAULT '' NOT NULL,
	`trigger` text DEFAULT '' NOT NULL,
	`give_up` text DEFAULT '' NOT NULL,
	`position_cap` real,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_date_unique` ON `plans` (`date`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT '未查得' NOT NULL,
	`self_zt_all` integer,
	`self_zt_no_st` integer,
	`self_zt_desk` integer,
	`self_dt_desk` integer,
	`self_touched_desk` integer,
	`self_seal_rate_desk` real,
	`em_zt` integer,
	`em_zb` integer,
	`em_dt` integer,
	`em_seal_rate` real,
	`ths_zt` integer,
	`desk_limit_up_count` integer,
	`desk_limit_down_count` integer,
	`lbc_mismatch` text DEFAULT '[]' NOT NULL,
	`lbc_top` text DEFAULT '[]' NOT NULL,
	`diff` text DEFAULT '{}' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliations_date_unique` ON `reconciliations` (`date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`sell_date` text,
	`name` text NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`buy_price` real NOT NULL,
	`sell_price` real,
	`shares` integer NOT NULL,
	`buy_reason` text DEFAULT '' NOT NULL,
	`followed_plan` integer DEFAULT 1 NOT NULL,
	`mode` text DEFAULT '' NOT NULL,
	`planned_override` text DEFAULT '' NOT NULL,
	`sell_reason` text DEFAULT '' NOT NULL,
	`emotion` text DEFAULT '' NOT NULL,
	`error_tags` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
