<template>
  <div class="t-card-body">
    <div class="d-flex justify-content-between">
      <p class="t-card-title">{{task.title}}</p>

      <img
          class="t-card-img"
          src="https://pickaface.net/gallery/avatar/unr_sample_161118_2054_ynlrg.png"
          alt="Avatar"
      >
    </div>
    <div class="d-flex mt-4 justify-content-between align-items-center">
      <span class="text-sm text-gray-600">{{task.date}}</span>
      <span :class="['badge', badgeColor.bg]"><i :class="['fa fa-circle', badgeColor.color]"></i> تست</span>
    </div>
  </div>
</template>
<script>
import Badge from "./Badge.vue";
export default {
  components: {
    Badge
  },
  props: {
    task: {
      type: Object,
      default: () => ({})
    }
  },
  computed: {
    badgeColor() {
      const mappings = {
        success: {bg: "bg-success-bright", color: "text-success"},
        warning: {bg: "bg-warning-bright", color: "text-warning"},
        danger: {bg: "bg-danger-bright", color: "text-danger"},
        info: {bg: "bg-info-bright", color: "text-info"},
        secondary: {bg: "bg-secondary-bright", color: "text-secondary"},
        primary: {bg: "bg-primary-bright", color: "text-primary"}
      };
      return mappings[this.task.type] || mappings.default;
    }
  }
};
</script>
<style scoped>
.t-card-body{
  box-shadow: 0 1px 3px 0 rgb(0 0 0/10%), 0 1px 2px 0 rgb(0 0 0/6%);
  padding: 0.75rem 0.75rem 1.25rem;
  margin-top: 0.75rem;
  cursor: move;
  border-width: 1px;
  border-radius: 0.25rem;
  --border-opacity: 1;
  border-color: #fff;
  border-color: rgba(255,255,255,var(--border-opacity));
  --bg-opacity: 1;
  background-color: #fff;
  background-color: rgba(255,255,255,var(--bg-opacity));
}
.t-card-title{
  letter-spacing: .025em;
  --text-opacity: 1;
  color: #4a5568;
  color: rgba(74,85,104,var(--text-opacity));
  font-size: .875rem;
  font-weight: 600;
  margin: 0;
}
.t-card-img{
  width: 1.5rem;
  margin-right: 0.75rem;
  height: 1.5rem;
  border-radius: 9999px;
  max-width: 100%;
  display: block;
  vertical-align: middle;
  border: solid 2px #b5b5b5;
}
</style>