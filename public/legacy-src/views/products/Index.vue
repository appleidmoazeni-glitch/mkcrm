<template>
  <main class="main-content">
    <div class="card">
      <div class="card-body">
        salam
      </div>
    </div>
  </main>
</template>

<script>

export default {
  data() {
    return {
      loading: false,
      selection: 1,
    }
  },
  methods: {
    reserve () {
      this.loading = true

      setTimeout(() => (this.loading = false), 2000)
    },
  },
}
</script>

<style scoped>
.el-carousel__item h3 {
  color: #475669;
  font-size: 18px;
  opacity: 0.75;
  line-height: 300px;
  margin: 0;
}

.el-carousel__item:nth-child(2n) {
  background-color: #99a9bf;
}

.el-carousel__item:nth-child(2n+1) {
  background-color: #d3dce6;
}
</style>
