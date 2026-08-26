"use client";

import { App, Button, Input, Modal, Select } from "antd";
import { Flag } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { submitWorkReport } from "@/services/api/work-governance";
import { useUserStore } from "@/stores/use-user-store";

const REPORT_OPTIONS = [
    { value: "illegal", label: "违规内容" },
    { value: "copyright", label: "侵权内容" },
    { value: "privacy", label: "泄露隐私" },
    { value: "spam", label: "垃圾或广告" },
    { value: "other", label: "其他问题" },
];

export function PublicWorkReportButton({ slug, compact = false, className }: { slug: string; compact?: boolean; className?: string }) {
    const { message } = App.useApp();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState("illegal");
    const [description, setDescription] = useState("");
    const [loading, setLoading] = useState(false);

    const startReport = () => {
        if (!user) {
            router.push(`/login?next=${encodeURIComponent(`/share/${slug}`)}`);
            return;
        }
        setOpen(true);
    };

    const submit = async () => {
        if (description.trim().length < 5) return message.warning("请至少填写 5 个字的举报说明");
        setLoading(true);
        try {
            await submitWorkReport(slug, { category, description: description.trim() });
            message.success("举报已提交，平台会尽快复核");
            setOpen(false);
            setDescription("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提交举报失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Button className={className} size={compact ? "small" : "middle"} icon={<Flag className="size-4" />} onClick={startReport} aria-label="举报作品">
                {compact ? null : "举报"}
            </Button>
            <Modal title="举报作品" open={open} okText="提交举报" cancelText="取消" confirmLoading={loading} okButtonProps={{ disabled: description.trim().length < 5 }} onOk={() => void submit()} onCancel={() => !loading && setOpen(false)}>
                <div className="grid gap-4 pt-2">
                    <div>
                        <div className="mb-2 text-sm font-medium">问题类型</div>
                        <Select className="w-full" value={category} options={REPORT_OPTIONS} onChange={setCategory} />
                    </div>
                    <div>
                        <div className="mb-2 text-sm font-medium">举报说明</div>
                        <Input.TextArea value={description} rows={5} maxLength={1000} showCount placeholder="请描述具体问题和出现位置，便于平台核实" onChange={(event) => setDescription(event.target.value)} />
                    </div>
                </div>
            </Modal>
        </>
    );
}
