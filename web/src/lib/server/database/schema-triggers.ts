export const POSTGRESQL_TRIGGER_SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION vozeb_pro_notify_generation_task_change()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('vozeb_pro_generation_task_events', OLD.id);
        RETURN OLD;
    END IF;
    PERFORM pg_notify('vozeb_pro_generation_task_events', NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generation_tasks_event_notify ON generation_tasks;
CREATE TRIGGER generation_tasks_event_notify AFTER INSERT OR UPDATE OR DELETE ON generation_tasks FOR EACH ROW EXECUTE FUNCTION vozeb_pro_notify_generation_task_change();

DROP TRIGGER IF EXISTS entitlement_plans_set_updated_at ON entitlement_plans;
CREATE TRIGGER entitlement_plans_set_updated_at BEFORE UPDATE ON entitlement_plans FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS app_settings_set_updated_at ON app_settings;
CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS system_model_channels_set_updated_at ON system_model_channels;
CREATE TRIGGER system_model_channels_set_updated_at BEFORE UPDATE ON system_model_channels FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS daily_plan_point_wallets_set_updated_at ON daily_plan_point_wallets;
CREATE TRIGGER daily_plan_point_wallets_set_updated_at BEFORE UPDATE ON daily_plan_point_wallets FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS billing_products_set_updated_at ON billing_products;
CREATE TRIGGER billing_products_set_updated_at BEFORE UPDATE ON billing_products FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS promotion_campaigns_set_updated_at ON promotion_campaigns;
CREATE TRIGGER promotion_campaigns_set_updated_at BEFORE UPDATE ON promotion_campaigns FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS coupon_templates_set_updated_at ON coupon_templates;
CREATE TRIGGER coupon_templates_set_updated_at BEFORE UPDATE ON coupon_templates FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS billing_orders_set_updated_at ON billing_orders;
CREATE TRIGGER billing_orders_set_updated_at BEFORE UPDATE ON billing_orders FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS user_coupons_set_updated_at ON user_coupons;
CREATE TRIGGER user_coupons_set_updated_at BEFORE UPDATE ON user_coupons FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS coupon_redemptions_set_updated_at ON coupon_redemptions;
CREATE TRIGGER coupon_redemptions_set_updated_at BEFORE UPDATE ON coupon_redemptions FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS payment_transactions_set_updated_at ON payment_transactions;
CREATE TRIGGER payment_transactions_set_updated_at BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS billing_refund_jobs_set_updated_at ON billing_refund_jobs;
CREATE TRIGGER billing_refund_jobs_set_updated_at BEFORE UPDATE ON billing_refund_jobs FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS referral_programs_set_updated_at ON referral_programs;
CREATE TRIGGER referral_programs_set_updated_at BEFORE UPDATE ON referral_programs FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS referral_codes_set_updated_at ON referral_codes;
CREATE TRIGGER referral_codes_set_updated_at BEFORE UPDATE ON referral_codes FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS referral_relationships_set_updated_at ON referral_relationships;
CREATE TRIGGER referral_relationships_set_updated_at BEFORE UPDATE ON referral_relationships FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS referral_rewards_set_updated_at ON referral_rewards;
CREATE TRIGGER referral_rewards_set_updated_at BEFORE UPDATE ON referral_rewards FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS published_works_set_updated_at ON published_works;
CREATE TRIGGER published_works_set_updated_at BEFORE UPDATE ON published_works FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS published_work_versions_set_updated_at ON published_work_versions;
CREATE TRIGGER published_work_versions_set_updated_at BEFORE UPDATE ON published_work_versions FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS published_work_cases_set_updated_at ON published_work_cases;
CREATE TRIGGER published_work_cases_set_updated_at BEFORE UPDATE ON published_work_cases FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
DROP TRIGGER IF EXISTS billing_reconciliation_runs_set_updated_at ON billing_reconciliation_runs;
CREATE TRIGGER billing_reconciliation_runs_set_updated_at BEFORE UPDATE ON billing_reconciliation_runs FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS billing_reconciliation_rows_set_updated_at ON billing_reconciliation_rows;
CREATE TRIGGER billing_reconciliation_rows_set_updated_at BEFORE UPDATE ON billing_reconciliation_rows FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS user_plan_assignments_set_updated_at ON user_plan_assignments;
CREATE TRIGGER user_plan_assignments_set_updated_at BEFORE UPDATE ON user_plan_assignments FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS payment_provider_events_set_updated_at ON payment_provider_events;
CREATE TRIGGER payment_provider_events_set_updated_at BEFORE UPDATE ON payment_provider_events FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS cdk_codes_set_updated_at ON cdk_codes;
CREATE TRIGGER cdk_codes_set_updated_at BEFORE UPDATE ON cdk_codes FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS announcements_set_updated_at ON announcements;
CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS prompts_set_updated_at ON prompts;
CREATE TRIGGER prompts_set_updated_at BEFORE UPDATE ON prompts FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS drama_projects_set_updated_at ON drama_projects;
CREATE TRIGGER drama_projects_set_updated_at BEFORE UPDATE ON drama_projects FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS generation_logs_set_updated_at ON generation_logs;
CREATE TRIGGER generation_logs_set_updated_at BEFORE UPDATE ON generation_logs FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();

DROP TRIGGER IF EXISTS object_storage_settings_set_updated_at ON object_storage_settings;
CREATE TRIGGER object_storage_settings_set_updated_at BEFORE UPDATE ON object_storage_settings FOR EACH ROW EXECUTE FUNCTION vozeb_pro_set_updated_at();
`;
