<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header">
        <h5>اهداف ارزیابی</h5>
        <div class="items form-inline">
          <button class="btn btn-success mr-2" type="button"><i class="fa fa-file-o ml-2"></i><span>هدف جدید</span></button>
        </div>
      </div>
      <div class="card-body p-0 table-orders">
        <b-skeleton-table v-if="loading.data"
            :rows="5"
            :columns="4"
            :table-props="{ bordered: true, striped: true }"
        ></b-skeleton-table>
        <div v-else class="card-scroll h-100">
          <div class="table-responsive">
            <table :class="['table table-hover']" class="table table-hover" width="100%">
              <thead>
              <tr>
                <th>عنوان هدف</th>
                <th>کلید</th>
                <th>تاریخ ایجاد</th>
                <th></th>
              </tr>
              </thead>
              <tbody>
              <tr>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
<script type="ts">
export default {
  data(){return {
    loading: {data: true}
  }}
}
</script>
<style scoped>
.items{
  /* margin-top: 10px; */
  position: absolute;
  left: 11px;
  top: 8px;
}
</style>
