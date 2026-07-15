<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header d-flex justify-content-between">
        <h5>صورت حساب</h5>
        <h5>{{ time }}</h5>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <b-skeleton-table v-if="loading" :rows="2" :columns="1" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
          <table v-else class="table table-hover">
            <thead>
            <tr>
              <th>شماره سند</th>
              <th>بابت</th>
              <th>نوع</th>
              <th>مبلغ (ریال)</th>
              <th>تاریخ</th>
              <th>عملیات</th>
            </tr>
            </thead>
            <tbody>
            <tr v-for="row of data">
              <td>{{row.id}}</td>
              <td>{{row.comment}}</td>
              <td :class="row.type=='DEPOSIT' ? 'text-success' : 'text-danger'">{{row.type=='DEPOSIT' ? "واریز" : "برداشت"}}</td>
              <td :class="row.type=='DEPOSIT' ? 'text-success' : 'text-danger'" style="font-family: Arial; direction: ltr">{{number_format(row.amount)}}</td>
              <td class="ltr"><i class="far fa-clock"></i> {{new Date(row.created_at).echoFa("Y/m/d")}} <i class="far fa-calendar-alt"></i> {{new Date(row.created_at).echoFa("H:i")}}</td>
              <td></td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card-footer text-muted">
        <div class="data-table-toolbar d-flex justify-content-center">
          <b-pagination-nav v-model="meta.current_page" :number-of-pages="meta.last_page" base-url="#" first-number last-number></b-pagination-nav>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import util from '../../assets/pureFunctions'
import axios from "axios";
export default {
  data(){
    return {
      data: [],
      loading: false,
      time: "00:00",
      meta: {
        current_page: 1,
        from: 0,
        last_page: 1,
        per_page: 5,
        to: 0,
        total: 0
      },
      number_format: util.number_format
    }
  },
  mounted() {
    if(!util.getAuthenticateTime()){
      this.$router.push('/wallet/authenticate');
    }
    let timer = setInterval(()=>{
      let tm = util.getAuthenticateTime();
      this.time = util.toTimeFormat(tm);
      if( tm < 1 ){
        clearInterval(timer);
        this.$router.push('/wallet/authenticate');
      }
    }, 1000);
    this.getData();
  },
  methods:{
    getData(){
      this.loading = true;
      axios.get('/admin/wallet/authenticate/statements', {params: {page: this.meta.current_page}}).then(({data}) => {
        if( data ){
          this.data = data.data;
          this.meta = data.meta;
          util.setAuthenticateTime(data.expireTime)
        }
        this.loading = false;
      }).catch(err => {
        toastr['error']("خطا در فراخوانی اطلاعات.");
        this.loading = false;
      })
    }
  },
  watch: {
    "meta.current_page": {
      handler(value){
        this.getData();
      }
    }
  }
}
</script>

<style scoped>

</style>
