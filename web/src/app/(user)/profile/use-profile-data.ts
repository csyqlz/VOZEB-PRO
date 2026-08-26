"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";

import { listBillingCoupons, listBillingOrders, listBillingProducts, type BillingOrder, type BillingProduct, type CouponTemplate, type UserCoupon } from "@/services/api/billing";
import { listPointRecords, type PointRecord } from "@/services/api/points";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

import { COUPON_PAGE_SIZE, ORDER_PAGE_SIZE, RECORD_PAGE_SIZE, type ProfileSectionKey } from "./profile-elements";

export function useProfileData(activeSection: ProfileSectionKey) {
    const { message } = App.useApp();
    const setUser = useUserStore((state) => state.setUser);
    const [products, setProducts] = useState<BillingProduct[]>([]);
    const [productsLoaded, setProductsLoaded] = useState(false);
    const [productsLoading, setProductsLoading] = useState(false);
    const [coupons, setCoupons] = useState<UserCoupon[]>([]);
    const [couponTemplates, setCouponTemplates] = useState<CouponTemplate[]>([]);
    const [couponTemplatesTotal, setCouponTemplatesTotal] = useState(0);
    const [couponTemplatesPage, setCouponTemplatesPage] = useState(1);
    const [couponsTotal, setCouponsTotal] = useState(0);
    const [couponsPage, setCouponsPage] = useState(1);
    const [couponsLoadedPage, setCouponsLoadedPage] = useState<number | null>(null);
    const [couponsLoading, setCouponsLoading] = useState(false);
    const [orders, setOrders] = useState<BillingOrder[]>([]);
    const [ordersTotal, setOrdersTotal] = useState(0);
    const [ordersPage, setOrdersPage] = useState(1);
    const [ordersLoadedPage, setOrdersLoadedPage] = useState<number | null>(null);
    const [ordersLoading, setOrdersLoading] = useState(false);
    const [pointRecords, setPointRecords] = useState<PointRecord[]>([]);
    const [pointRecordsTotal, setPointRecordsTotal] = useState(0);
    const [pointRecordsPage, setPointRecordsPage] = useState(1);
    const [pointRecordsLoadedPage, setPointRecordsLoadedPage] = useState<number | null>(null);
    const [pointRecordsLoading, setPointRecordsLoading] = useState(false);
    const [consumeRecords, setConsumeRecords] = useState<PointRecord[]>([]);
    const [consumeRecordsTotal, setConsumeRecordsTotal] = useState(0);
    const [consumeRecordsPage, setConsumeRecordsPage] = useState(1);
    const [consumeRecordsLoadedPage, setConsumeRecordsLoadedPage] = useState<number | null>(null);
    const [consumeRecordsLoading, setConsumeRecordsLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const productsRequest = useRef(false);
    const couponsRequestPage = useRef<number | null>(null);
    const couponsQueuedRequest = useRef<{ page: number; refreshTemplates: boolean; templatePage: number } | null>(null);
    const couponTemplatesLoaded = useRef(false);
    const ordersRequestPage = useRef<number | null>(null);
    const pointsRequestPage = useRef<number | null>(null);
    const consumptionRequestPage = useRef<number | null>(null);

    const loadProducts = useCallback(async () => {
        if (productsRequest.current) return;
        productsRequest.current = true;
        setProductsLoading(true);
        try {
            const payload = await listBillingProducts();
            setProducts(payload.products || []);
            setProductsLoaded(true);
        } catch (error) {
            setProducts([]);
            setProductsLoaded(true);
            message.error(error instanceof Error ? error.message : "充值套餐加载失败");
        } finally {
            productsRequest.current = false;
            setProductsLoading(false);
        }
    }, [message]);

    const loadOrders = useCallback(
        async (page: number) => {
            if (ordersRequestPage.current !== null) return;
            ordersRequestPage.current = page;
            setOrdersLoading(true);
            try {
                const payload = await listBillingOrders({ page, pageSize: ORDER_PAGE_SIZE });
                setOrders(payload.orders || []);
                setOrdersTotal(payload.total || 0);
                setOrdersLoadedPage(page);
            } catch (error) {
                setOrders([]);
                setOrdersTotal(0);
                setOrdersLoadedPage(page);
                message.error(error instanceof Error ? error.message : "订单记录加载失败");
            } finally {
                if (ordersRequestPage.current === page) ordersRequestPage.current = null;
                setOrdersLoading(false);
            }
        },
        [message],
    );

    const loadCoupons = useCallback(
        async (page: number, options: { refreshTemplates?: boolean; templatePage?: number } = {}) => {
            const normalizedPage = Math.max(1, Math.floor(page));
            const request = { page: normalizedPage, refreshTemplates: options.refreshTemplates === true, templatePage: Math.max(1, Math.floor(options.templatePage || 1)) };
            if (couponsRequestPage.current !== null) {
                couponsQueuedRequest.current = request;
                return;
            }
            couponsRequestPage.current = normalizedPage;
            setCouponsLoading(true);
            try {
                let currentRequest = request;
                while (true) {
                    try {
                        const payload = await listBillingCoupons({
                            page: currentRequest.page,
                            pageSize: COUPON_PAGE_SIZE,
                            includeTemplates: currentRequest.refreshTemplates || !couponTemplatesLoaded.current,
                            templatePage: currentRequest.templatePage,
                            templatePageSize: COUPON_PAGE_SIZE,
                        });
                        if (payload.templates !== undefined) {
                            setCouponTemplates(payload.templates);
                            setCouponTemplatesTotal(payload.templatesTotal || 0);
                            setCouponTemplatesPage(payload.templatePage || currentRequest.templatePage);
                            couponTemplatesLoaded.current = true;
                        }
                        const queuedRequest = couponsQueuedRequest.current;
                        if (queuedRequest !== null) {
                            couponsQueuedRequest.current = null;
                            currentRequest = queuedRequest;
                            couponsRequestPage.current = currentRequest.page;
                            continue;
                        }
                        setCoupons(payload.coupons || []);
                        setCouponsTotal(payload.total || 0);
                        setCouponsLoadedPage(payload.page || currentRequest.page);
                        break;
                    } catch (error) {
                        const queuedRequest = couponsQueuedRequest.current;
                        if (queuedRequest === null) throw error;
                        couponsQueuedRequest.current = null;
                        currentRequest = queuedRequest;
                        couponsRequestPage.current = currentRequest.page;
                    }
                }
            } catch (error) {
                message.error(error instanceof Error ? error.message : "优惠券加载失败");
            } finally {
                couponsRequestPage.current = null;
                setCouponsLoading(false);
            }
        },
        [message],
    );

    const loadPointRecords = useCallback(
        async (page: number) => {
            if (pointsRequestPage.current !== null) return;
            pointsRequestPage.current = page;
            setPointRecordsLoading(true);
            try {
                const payload = await listPointRecords({ page, pageSize: RECORD_PAGE_SIZE });
                setPointRecords(payload.records);
                setPointRecordsTotal(payload.total);
                setPointRecordsLoadedPage(page);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "余额记录加载失败");
            } finally {
                if (pointsRequestPage.current === page) pointsRequestPage.current = null;
                setPointRecordsLoading(false);
            }
        },
        [message],
    );

    const loadConsumeRecords = useCallback(
        async (page: number) => {
            if (consumptionRequestPage.current !== null) return;
            consumptionRequestPage.current = page;
            setConsumeRecordsLoading(true);
            try {
                const payload = await listPointRecords({ page, pageSize: RECORD_PAGE_SIZE, direction: "debit", view: "consumption" });
                setConsumeRecords(payload.records);
                setConsumeRecordsTotal(payload.total);
                setConsumeRecordsLoadedPage(page);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "消费记录加载失败");
            } finally {
                if (consumptionRequestPage.current === page) consumptionRequestPage.current = null;
                setConsumeRecordsLoading(false);
            }
        },
        [message],
    );

    const needsOrders = activeSection === "overview" || activeSection === "orders";
    const ordersTargetPage = activeSection === "overview" ? 1 : ordersPage;
    const needsPoints = activeSection === "overview" || activeSection === "points";
    const pointsTargetPage = activeSection === "overview" ? 1 : pointRecordsPage;

    useEffect(() => {
        if (activeSection === "billing" && !productsLoaded) void loadProducts();
    }, [activeSection, loadProducts, productsLoaded]);

    useEffect(() => {
        if (activeSection === "coupons" && couponsLoadedPage !== couponsPage) void loadCoupons(couponsPage);
    }, [activeSection, couponsLoadedPage, couponsPage, loadCoupons]);

    useEffect(() => {
        if (needsOrders && ordersLoadedPage !== ordersTargetPage) void loadOrders(ordersTargetPage);
    }, [loadOrders, needsOrders, ordersLoadedPage, ordersTargetPage]);

    useEffect(() => {
        if (needsPoints && pointRecordsLoadedPage !== pointsTargetPage) void loadPointRecords(pointsTargetPage);
    }, [loadPointRecords, needsPoints, pointRecordsLoadedPage, pointsTargetPage]);

    useEffect(() => {
        if (activeSection === "consume" && consumeRecordsLoadedPage !== consumeRecordsPage) void loadConsumeRecords(consumeRecordsPage);
    }, [activeSection, consumeRecordsLoadedPage, consumeRecordsPage, loadConsumeRecords]);

    const refreshUser = useCallback(async () => {
        try {
            const response = await fetch("/api/auth/session", { cache: "no-store" });
            const payload = (await response.json()) as { user?: LocalUser | null };
            if (payload.user) setUser(payload.user);
        } catch {
            // The visible section refresh remains useful if the session refresh is temporarily unavailable.
        }
    }, [setUser]);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const requests: Promise<void>[] = [refreshUser()];
            if (activeSection === "overview") requests.push(loadOrders(1), loadPointRecords(1));
            else if (activeSection === "billing") requests.push(loadProducts());
            else if (activeSection === "coupons") requests.push(loadCoupons(couponsPage));
            else if (activeSection === "orders") requests.push(loadOrders(ordersPage));
            else if (activeSection === "consume") requests.push(loadConsumeRecords(consumeRecordsPage));
            else if (activeSection === "points") requests.push(loadPointRecords(pointRecordsPage));
            await Promise.all(requests);
        } finally {
            setRefreshing(false);
        }
    }, [activeSection, consumeRecordsPage, couponsPage, loadConsumeRecords, loadCoupons, loadOrders, loadPointRecords, loadProducts, ordersPage, pointRecordsPage, refreshUser]);

    const refreshCoupons = useCallback(() => loadCoupons(couponsPage, { refreshTemplates: true, templatePage: couponTemplatesPage }), [couponTemplatesPage, couponsPage, loadCoupons]);
    const changeCouponTemplatePage = useCallback(
        (page: number) => {
            const normalizedPage = Math.max(1, Math.floor(page));
            setCouponTemplatesPage(normalizedPage);
            return loadCoupons(couponsPage, { refreshTemplates: true, templatePage: normalizedPage });
        },
        [couponsPage, loadCoupons],
    );
    const refreshCouponsAfterClaim = useCallback(async () => {
        setCouponsPage(1);
        setCouponTemplatesPage(1);
        await loadCoupons(1, { refreshTemplates: true, templatePage: 1 });
    }, [loadCoupons]);

    return {
        products: { items: products, loading: productsLoading || (activeSection === "billing" && !productsLoaded), refresh: loadProducts },
        coupons: {
            items: coupons,
            templates: couponTemplates,
            templatesTotal: couponTemplatesTotal,
            templatePage: couponTemplatesPage,
            total: couponsTotal,
            page: couponsPage,
            setPage: setCouponsPage,
            loading: couponsLoading || (activeSection === "coupons" && couponsLoadedPage !== couponsPage),
            refresh: refreshCoupons,
            setTemplatePage: changeCouponTemplatePage,
            refreshAfterClaim: refreshCouponsAfterClaim,
        },
        orders: { items: orders, total: ordersTotal, page: ordersPage, setPage: setOrdersPage, loading: ordersLoading || (needsOrders && ordersLoadedPage !== ordersTargetPage) },
        points: { items: pointRecords, total: pointRecordsTotal, page: pointRecordsPage, setPage: setPointRecordsPage, loading: pointRecordsLoading || (needsPoints && pointRecordsLoadedPage !== pointsTargetPage) },
        consumption: {
            items: consumeRecords,
            total: consumeRecordsTotal,
            page: consumeRecordsPage,
            setPage: setConsumeRecordsPage,
            loading: consumeRecordsLoading || (activeSection === "consume" && consumeRecordsLoadedPage !== consumeRecordsPage),
        },
        loading: refreshing || productsLoading || couponsLoading || ordersLoading || pointRecordsLoading || consumeRecordsLoading,
        refresh,
    };
}
