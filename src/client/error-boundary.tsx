import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** เปลี่ยนค่าเมื่อไร ขอบเขตจะล้างข้อผิดพลาดเดิม เช่น เปลี่ยนเส้นทาง */
  resetKey?: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * กันจอขาวเมื่อคอมโพเนนต์โยนข้อผิดพลาดกลางการเรนเดอร์
 * ยังต้องเป็นคลาสเพราะ React ไม่มีขอบเขตข้อผิดพลาดแบบฮุก
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      JSON.stringify({
        message: "render failed",
        error: error.message,
        componentStack: info.componentStack,
      }),
    );
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className="mx-auto w-full max-w-[520px] px-4 py-10">
        <Card>
          <span
            className="ms grid h-12 w-12 place-items-center rounded-xl bg-danger-soft text-[1.5rem] text-danger"
            aria-hidden="true"
          >
            error
          </span>
          <h1 className="mt-3 text-xl text-charcoal">หน้านี้แสดงไม่สำเร็จ</h1>
          <p className="mt-1 text-sm text-steel">
            เกิดข้อผิดพลาดระหว่างแสดงผล ข้อมูลที่บันทึกไว้แล้วไม่ได้รับผลกระทบ
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => {
                this.setState({ failed: false });
              }}
            >
              ลองใหม่
            </Button>
            <Button
              variant="secondary"
              icon="home"
              onClick={() => {
                window.location.hash = "#dashboard";
                this.setState({ failed: false });
              }}
            >
              กลับหน้าแดชบอร์ด
            </Button>
          </div>
        </Card>
      </div>
    );
  }
}
