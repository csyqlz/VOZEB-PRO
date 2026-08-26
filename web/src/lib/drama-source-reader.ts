import { unzipSync } from "fflate";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function readDramaSourceFile(file: File) {
    if (!isDocxFile(file)) return file.text();
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const documentXml = entries["word/document.xml"];
    if (!documentXml) throw new Error("Word 文档缺少正文内容");
    return extractWordDocumentText(new TextDecoder().decode(documentXml));
}

export function isDocxFile(file: Pick<File, "name" | "type">) {
    return file.type === DOCX_MIME || /\.docx$/iu.test(file.name);
}

export function extractWordDocumentText(documentXml: string) {
    if (typeof DOMParser === "undefined") throw new Error("当前浏览器不支持 Word 文档解析");
    const document = new DOMParser().parseFromString(documentXml, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Word 文档正文格式无效");
    const paragraphs = Array.from(document.getElementsByTagNameNS(WORD_NAMESPACE, "p"));
    const text = paragraphs.map(readWordParagraph).join("\n").trim();
    if (!text) throw new Error("Word 文档没有可识别的正文内容");
    return text;
}

function readWordParagraph(paragraph: Element) {
    let value = "";
    const visit = (node: Node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const element = child as Element;
            switch (element.localName) {
                case "t":
                    value += element.textContent || "";
                    break;
                case "tab":
                    value += "\t";
                    break;
                case "br":
                case "cr":
                    value += "\n";
                    break;
                default:
                    visit(element);
            }
        }
    };
    visit(paragraph);
    return value.trim();
}
