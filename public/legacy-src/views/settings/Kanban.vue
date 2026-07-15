<template>
  <main class="main-content">
    <div class="d-flex">
      <div class="kanban-lists">
        <div v-for="column in columns" :key="column.title" class="kanban-cols">
          <p class="kanban-title">{{column.title}}</p>
          <!-- Draggable component comes from vuedraggable. It provides drag & drop functionality -->
          <draggable :list="column.tasks" :animation="200" ghost-class="ghost-card" group="tasks">
            <!-- Each element from here will be draggable and animated. Note :key is very important here to be unique both for draggable and animations to be smooth & consistent. -->
            <task-card
                v-for="(task) in column.tasks"
                :key="task.id"
                :task="task"
                class="mt-3 cursor-move"
            ></task-card>
            <!-- </transition-group> -->
          </draggable>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import draggable from "vuedraggable";
import TaskCard from "../../components/TaskCard";
export default{
  components: {
    TaskCard,
    draggable
  },
  data() {
    return {
      columns: [
        {
          title: "لیست وظایف",
          tasks: [
            {
              id: 1,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            },
            {
              id: 2,
              title: "ارائه مستندات در مورد ادغام",
              date: "12 آبان"
            },
            {
              id: 3,
              title: "طراحی کشویی سبد خرید",
              date: "9 آبان",
              type: "warning"
            },
            {
              id: 4,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            },
            {
              id: 5,
              title: "جریان پرداخت را آزمایش کنید",
              date: "15 آبان"
            }
          ]
        },
        {
          title: "در حال انجام",
          tasks: [
            {
              id: 6,
              title: "طراحی کشویی سبد خرید",
              date: "9 آبان",
              type: "info"
            },
            {
              id: 7,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            },
            {
              id: 8,
              title: "ارائه مستندات در مورد ادغام",
              date: "12 آبان",
              type: "warning"
            }
          ]
        },
        {
          title: "بررسی نهایی",
          tasks: [
            {
              id: 9,
              title: "ارائه مستندات در مورد ادغام",
              date: "12 آبان"
            },
            {
              id: 10,
              title: "طراحی کشویی سبد خرید",
              date: "9 آبان",
              type: "warning"
            },
            {
              id: 11,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            },
            {
              id: 12,
              title: "طراحی کشویی سبد خرید",
              date: "9 آبان",
              type: "primary"
            },
            {
              id: 13,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            }
          ]
        },
        {
          title: "انجام شده",
          tasks: [
            {
              id: 14,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            },
            {
              id: 15,
              title: "طراحی کشویی سبد خرید",
              date: "9 آبان",
              type: "warning"
            },
            {
              id: 16,
              title: "کد تخفیف را به صفحه پرداخت اضافه کنید",
              date: "14 آبان",
              type: "success"
            }
          ]
        }
      ]
    };
  }
}
</script>
<style scoped>
.kanban-lists{
  display: flex;
  padding-bottom: 3rem;
  overflow-x: scroll;
  min-height: 100vh;
}
.kanban-cols{
  min-width: 320px;
  width: 320px;
  padding: 0.75rem;
  margin-right: 1rem;
  border-radius: 0.5rem;
  --bg-opacity: 1;
  background-color: #f7fafc;
  background-color: rgba(247,250,252,var(--bg-opacity));
}
.kanban-cols:first-child{margin-right: 0;}
.kanban-title{
  letter-spacing: .025em;
  --text-opacity: 1;
  color: #4a5568;
  color: rgba(74,85,104,var(--text-opacity));
  font-size: .875rem;
  font-weight: 600;
  margin: 0;
}
.column-width {
  min-width: 320px;
  width: 320px;
}
/* Unfortunately @apply cannot be setup in codesandbox,
but you'd use "@apply border opacity-50 border-blue-500 bg-gray-200" here */
.ghost-card {
  opacity: 0.5;
  background: #F7FAFC;
  border: 1px solid #4299e1;
}
</style>
